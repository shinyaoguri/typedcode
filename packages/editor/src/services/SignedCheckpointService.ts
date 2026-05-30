/**
 * SignedCheckpointService - Workers の /api/checkpoint/sign に対する非同期クライアント.
 *
 * 役割:
 * - CheckpointManager の onCheckpointCreated フックを購読し、新規 checkpoint を
 *   Workers に送って ECDSA-P256 署名を取得する。
 * - 取得した envelope を TypingProof.attachSignedCheckpoint で書き戻す。
 * - オフライン/失敗時は指数バックオフで再送。
 * - 1 tab につき 1 インスタンス。`tabId` は constructor で固定。
 *
 * スコープ外 (将来):
 * - IndexedDB への queue 永続化。現状は in-memory + 既存の TypingProof.checkpoints
 *   のうち未署名のものを restore() で再キューする方式。
 * - 公開鍵の API フェッチ。本番運用時にも registry が source of truth。
 */

import type {
  CheckpointData,
  SignedCheckpointEnvelope,
  SignedCheckpointInput,
} from '@typedcode/shared';

export interface SignedCheckpointServiceOptions {
  apiUrl: string;
  sessionId: string;
  tabId: string;
  /** 現在の typingProof から initialEventChainHash を取り出す関数 */
  getInitialEventChainHash: () => string | null;
  /** 署名取得後、checkpoint に envelope を反映する callback */
  attachSignature: (eventIndex: number, envelope: SignedCheckpointEnvelope) => boolean;
  /** デフォルト: navigator.onLine 連動 */
  isOnline?: () => boolean;
  /** デフォルト: window.fetch */
  fetchImpl?: typeof fetch;
  /** デフォルト: 1000ms, 2000ms, 4000ms, ..., max 60_000ms */
  backoffSchedule?: number[];
  /** 1 リクエスト最大試行回数 (バックオフ枯渇後は drop) */
  maxAttemptsPerCheckpoint?: number;
}

interface QueuedEntry {
  /** sign 直前に確定するフィールドを除いた基礎情報 */
  base: {
    eventIndex: number;
    chainHash: string;
    contentHash: string;
    clientTimestamp: string;
  };
  attempts: number;
  /** スケジュール済みの setTimeout id */
  retryTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000, 60000];
const DEFAULT_MAX_ATTEMPTS = 10;

/**
 * VITE_API_URL が設定されていれば SignedCheckpointService を返す。
 * 未設定 (開発環境などで Workers が起動していない) の場合は null。
 */
export function createSignedCheckpointServiceIfEnabled(
  params: Omit<SignedCheckpointServiceOptions, 'apiUrl'>
): SignedCheckpointService | null {
  const apiUrl = import.meta.env?.VITE_API_URL;
  if (!apiUrl) return null;
  return new SignedCheckpointService({ apiUrl, ...params });
}

/**
 * 未署名の checkpoint を Worker に送って ECDSA-P256 envelope を取得し、書き戻すサービス。
 *
 * 注: chain state (previousSignedCheckpointHash, lastCheckpointIndex, lastEventIndex)
 * は内部で保持する。restore() で過去の signed checkpoint を読み込むと正しく resume する。
 */
export class SignedCheckpointService {
  private readonly apiUrl: string;
  private readonly sessionId: string;
  private readonly tabId: string;
  private readonly getInitialEventChainHash: () => string | null;
  private readonly attachSignature: (
    eventIndex: number,
    envelope: SignedCheckpointEnvelope
  ) => boolean;
  private readonly isOnline: () => boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly backoffSchedule: number[];
  private readonly maxAttempts: number;

  /** Worker に未送信 (or 失敗中) の checkpoint */
  private readonly queue: Map<number, QueuedEntry> = new Map();
  /** 直近の正しく署名された checkpoint payload のハッシュ。連鎖計算用 */
  private previousSignedCheckpointHash: string | null = null;
  /** 直近に署名要求した checkpoint index (連続性確保) */
  private lastCheckpointIndex = -1;
  /** 直近に署名要求した eventIndex (totalEventsSincePrevious 計算用) */
  private lastEventIndex = -1;
  /** online/offline リスナのデタッチ用 */
  private onlineListener: (() => void) | null = null;
  /**
   * flush() の単一実行ガード。
   *
   * これが true の間、追加の flush() 呼び出しは no-op で即座にリターンする。
   * 旧実装では複数の flush() が並列に走り、同じ eventIndex に対する signOne()
   * を二重発火させ得た (応答が遅い checkpoint の直後に別の checkpoint が来た
   * ケース)。ネットワーク不安定下でサーバ応答が遅延すると顕在化し、
   * 同一 checkpointIndex に対して異なる serverTimestamp の envelope が二発返って
   * 上書きされ、後続の `previousSignedCheckpointHash` 連鎖が壊れていた。
   */
  private flushing = false;
  /** disposed flag */
  private disposed = false;

  constructor(options: SignedCheckpointServiceOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, '');
    this.sessionId = options.sessionId;
    this.tabId = options.tabId;
    this.getInitialEventChainHash = options.getInitialEventChainHash;
    this.attachSignature = options.attachSignature;
    this.isOnline = options.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine));
    // fetch は this===window バインディングを要求するので、参照を渡しただけだと
    // Illegal invocation になる。明示的に bind しておく。
    if (options.fetchImpl) {
      this.fetchImpl = options.fetchImpl;
    } else if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
      this.fetchImpl = window.fetch.bind(window);
    } else if (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function') {
      this.fetchImpl = globalThis.fetch.bind(globalThis);
    } else {
      this.fetchImpl = null as unknown as typeof fetch;
    }
    this.backoffSchedule = options.backoffSchedule ?? DEFAULT_BACKOFF_MS;
    this.maxAttempts = options.maxAttemptsPerCheckpoint ?? DEFAULT_MAX_ATTEMPTS;

    if (typeof window !== 'undefined') {
      this.onlineListener = () => this.flush();
      window.addEventListener('online', this.onlineListener);
    }
  }

  /**
   * 既存 (restore された) checkpoints から chain state を再構築。
   * - signed なものは previousSignedCheckpointHash を更新
   * - unsigned なものは queue に再 enqueue (ただし対応 event hash 等の context は外から
   *   流入する形ではなく checkpoint そのものから組み立てる)
   *
   * このメソッドは tab restore 時に 1 度だけ呼ぶ。
   */
  async restore(checkpoints: readonly CheckpointData[]): Promise<void> {
    // signed checkpoint のうち、payload.sessionId / tabId が一致するものだけ chain state に
    // 取り込む (他セッションの遺物は無視)
    const ourSigned = checkpoints.filter(
      (cp) =>
        cp.signature &&
        cp.signature.payload.sessionId === this.sessionId &&
        cp.signature.payload.tabId === this.tabId
    );

    if (ourSigned.length > 0) {
      const last = ourSigned[ourSigned.length - 1]!.signature!;
      const { hashSignedCheckpointPayload } = await import('@typedcode/shared/checkpoint');
      this.previousSignedCheckpointHash = await hashSignedCheckpointPayload(last.payload);
      this.lastCheckpointIndex = last.payload.checkpointIndex;
      this.lastEventIndex = last.payload.eventIndex;
    }

    // 未署名 checkpoint を queue に再投入
    for (const cp of checkpoints) {
      if (cp.signature) continue; // 既に署名済みの skip
      this.enqueueFromCheckpoint(cp);
    }

    if (this.queue.size > 0) {
      void this.flush();
    }
  }

  /**
   * CheckpointManager のフックから呼ばれるエントリポイント。
   */
  handleNewCheckpoint(checkpoint: CheckpointData): void {
    this.enqueueFromCheckpoint(checkpoint);
    void this.flush();
  }

  /**
   * Pending な checkpoint 件数 (UI / export 待機用)
   */
  pendingCount(): number {
    return this.queue.size;
  }

  /**
   * Pending が全て 0 になるか timeout まで待機。
   * ProofExporter の flush フェーズで呼ぶ。
   */
  async waitForFlush(timeoutMs: number): Promise<{ flushed: boolean; remaining: number }> {
    const startedAt = Date.now();
    while (this.queue.size > 0 && Date.now() - startedAt < timeoutMs) {
      // online であれば即時 flush を試みる
      if (this.isOnline()) {
        await this.flush();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { flushed: this.queue.size === 0, remaining: this.queue.size };
  }

  /**
   * リスナを解除。tab close 時に呼ぶ。
   */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.queue.values()) {
      if (entry.retryTimer) clearTimeout(entry.retryTimer);
    }
    this.queue.clear();
    if (this.onlineListener && typeof window !== 'undefined') {
      window.removeEventListener('online', this.onlineListener);
      this.onlineListener = null;
    }
  }

  // ---- internal ---------------------------------------------------------

  private enqueueFromCheckpoint(cp: CheckpointData): void {
    const eventIndex = cp.eventIndex;
    if (this.queue.has(eventIndex)) return;
    this.queue.set(eventIndex, {
      base: {
        eventIndex,
        chainHash: cp.hash,
        contentHash: cp.contentHash,
        clientTimestamp: new Date().toISOString(),
      },
      attempts: 0,
    });
  }

  /**
   * sign 直前に最新の chain state を取り込んで完全な input を構築。
   */
  private buildInput(entry: QueuedEntry): SignedCheckpointInput | null {
    const initialHash = this.getInitialEventChainHash();
    if (!initialHash) return null;
    return {
      sessionId: this.sessionId,
      tabId: this.tabId,
      checkpointIndex: this.lastCheckpointIndex + 1,
      eventIndex: entry.base.eventIndex,
      initialEventChainHash: initialHash,
      chainHash: entry.base.chainHash,
      contentHash: entry.base.contentHash,
      previousSignedCheckpointHash: this.previousSignedCheckpointHash,
      totalEventsSincePrevious: entry.base.eventIndex - this.lastEventIndex,
      clientTimestamp: entry.base.clientTimestamp,
    };
  }

  private async flush(): Promise<void> {
    if (this.disposed) return;
    // single-flight: 既に flush 中なら追加呼び出しは何もしない。
    // (signOne 中の await でループを抜けた後、queue に残りがあれば自分の while で
    //  処理するので取り零しは無い。新規 checkpoint で void this.flush() されても
    //  この guard で no-op に。)
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (!this.disposed && this.queue.size > 0) {
        if (!this.isOnline()) return;
        // 連鎖整合を保つため eventIndex の昇順で処理
        let nextEventIndex: number | null = null;
        for (const k of this.queue.keys()) {
          if (nextEventIndex === null || k < nextEventIndex) nextEventIndex = k;
        }
        if (nextEventIndex === null) return;
        const entry = this.queue.get(nextEventIndex);
        if (!entry) continue;
        const ok = await this.signOne(nextEventIndex, entry);
        if (!ok) return; // 失敗時は backoff 再試行 / online 復帰 / 次の handleNewCheckpoint に委ねる
      }
    } finally {
      this.flushing = false;
    }
  }

  private async signOne(eventIndex: number, entry: QueuedEntry): Promise<boolean> {
    if (this.disposed) return false;
    if (!this.fetchImpl) return false;
    const input = this.buildInput(entry);
    if (!input) {
      console.warn('[SignedCheckpointService] initialEventChainHash unavailable, skipping sign');
      return false;
    }
    entry.attempts++;
    try {
      const res = await this.fetchImpl(`${this.apiUrl}/api/checkpoint/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({})) as { code?: string; error?: string };
        return this.handleFailure(eventIndex, entry, `HTTP ${res.status} ${errBody.code ?? ''} ${errBody.error ?? ''}`.trim());
      }
      const body = (await res.json()) as { envelope: SignedCheckpointEnvelope };
      if (!body?.envelope) {
        return this.handleFailure(eventIndex, entry, 'response missing envelope');
      }
      const envelope = body.envelope;
      const attached = this.attachSignature(eventIndex, envelope);
      if (!attached) {
        // checkpoint が cleanup 済み等で見つからない場合は queue から外すだけ
        this.queue.delete(eventIndex);
        return true;
      }
      // 連鎖 state を更新
      const { hashSignedCheckpointPayload } = await import('@typedcode/shared/checkpoint');
      this.previousSignedCheckpointHash = await hashSignedCheckpointPayload(envelope.payload);
      this.lastCheckpointIndex = envelope.payload.checkpointIndex;
      this.lastEventIndex = envelope.payload.eventIndex;
      this.queue.delete(eventIndex);
      return true;
    } catch (err) {
      return this.handleFailure(eventIndex, entry, err instanceof Error ? err.message : String(err));
    }
  }

  private handleFailure(eventIndex: number, entry: QueuedEntry, reason: string): boolean {
    if (entry.attempts >= this.maxAttempts) {
      console.warn(
        `[SignedCheckpointService] giving up on checkpoint event=${eventIndex} after ${entry.attempts} attempts: ${reason}`
      );
      this.queue.delete(eventIndex);
      return false;
    }
    const delay = this.backoffSchedule[Math.min(entry.attempts - 1, this.backoffSchedule.length - 1)] ?? 60_000;
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = setTimeout(() => {
      void this.flush();
    }, delay);
    return false;
  }
}
