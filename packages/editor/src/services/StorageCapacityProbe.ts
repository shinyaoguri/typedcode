/**
 * StorageCapacityProbe - 起動時に必要な容量を実際に書いて確かめる (#626)
 *
 * Chromium の `navigator.storage.estimate()` は、ディスクが 10GB 以上あれば `usage + 10GB` を返し、
 * 空きディスク容量を反映しない。空きが 10MB の PC でも「十分」と出るので、実際に書き込んで判定する。
 *
 * - 書く先はセッション DB とは別の専用 DB (`STORAGE_PROBE_DB_NAME`)。`core/SessionDetector.ts` は
 *   モード別のセッション DB の名前しか開かないので、進行中のセッションとして数えられない
 * - 擬似乱数のチャンクを並べた Blob を 1 行 put し、transaction の commit (`settleOnCommit`) を待つ。
 *   request の success では書けた保証にならない (commit の時点で容量切れになりうる)
 * - 終わったら DB を close して `deleteDatabase` する。**開始時にも `deleteDatabase` する** (前回の試験が
 *   削除の前に落ちて、書いた分が残っていた場合の掃除)
 * - `timeoutMs` を超えたら transaction を abort して `inconclusive` を返す (遅い環境を容量不足と誤判定しない)。
 *   open の失敗・blocked、QuotaExceeded 以外の書き込み失敗も `inconclusive` (容量と無関係な失敗で警告しない)
 *
 * これは「その時点で書けた」ことの確認で、容量の確保ではない。結果はハッシュチェーンに記録しない。
 */

import { settleOnCommit } from './IndexedDBHelper.js';

/** 試験用の DB 名。セッション DB (`typedcode-session*`) と重ならない名前にする */
export const STORAGE_PROBE_DB_NAME = 'typedcode-storage-probe';

/**
 * 試験で書く量の既定値。授業 3 時間の典型 (約 90MB) に約 2 倍の余裕を見た値 (根拠は #626 の実測)。
 * docs/system-spec.md の定数表と揃える。
 */
export const STORAGE_PROBE_BYTES = 200 * 1024 * 1024;

/** 試験の上限時間。超えたら判定せずに打ち切る (低速な eMMC でも 1〜2 秒の見込み) */
export const STORAGE_PROBE_TIMEOUT_MS = 10_000;

/** Blob を組み立てるチャンクの大きさ。同じチャンクを並べるので、JS のヒープに載るのはこの分だけ */
const PROBE_CHUNK_BYTES = 8 * 1024 * 1024;

const PROBE_STORE = 'probe';
const PROBE_KEY = 'probe';

/** 判定できなかった理由 */
export type StorageProbeInconclusiveReason =
  /** `indexedDB` が無い */
  | 'unavailable'
  /** 試験用 DB を開けなかった */
  | 'open-failed'
  /** 試験用 DB の open が blocked になった (別の接続が古い版を開いている) */
  | 'blocked'
  /** 上限時間を超えた */
  | 'timeout'
  /** QuotaExceeded 以外の理由で書けなかった */
  | 'write-failed';

export type StorageProbeResult =
  | { kind: 'ok' }
  | { kind: 'insufficient'; error: unknown }
  | { kind: 'inconclusive'; reason: StorageProbeInconclusiveReason; error?: unknown };

export interface StorageProbeOptions {
  /** 書く量 (bytes)。既定は `STORAGE_PROBE_BYTES` */
  bytes?: number;
  /** 上限時間 (ms)。既定は `STORAGE_PROBE_TIMEOUT_MS` */
  timeoutMs?: number;
  /** 使う IDBFactory (テストで差し替える)。既定は `globalThis.indexedDB` */
  factory?: IDBFactory;
}

/**
 * 容量切れ (`QuotaExceededError`) か。`cause` の連鎖まで見る (`settleOnCommit` は失敗を
 * `new Error(..., { cause })` で包むため)。起動時の試験と、利用中の保存失敗の通知で共用する。
 */
export function isQuotaExceededError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    if ((current as { name?: unknown }).name === 'QuotaExceededError') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** 試験で書く量。dev ビルドに限り `VITE_STORAGE_PROBE_BYTES` の上書きを読む (正の整数のときだけ) */
export function resolveStorageProbeBytes(): number {
  if (import.meta.env.DEV) {
    const override = Number(import.meta.env.VITE_STORAGE_PROBE_BYTES);
    if (Number.isFinite(override) && override > 0) return Math.floor(override);
  }
  return STORAGE_PROBE_BYTES;
}

/**
 * 擬似乱数 (xorshift32、種は固定) で埋めたチャンク。値の中身に意味は無く、圧縮で実際の書き込み量が
 * 減らないように乱数にしている。`crypto.getRandomValues` は 1 回 64KB までなので使わない。
 */
function buildChunk(size: number): Uint8Array<ArrayBuffer> {
  const words = new Uint32Array(Math.ceil(size / 4));
  let x = 0x9e3779b9;
  for (let i = 0; i < words.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    words[i] = x >>> 0;
  }
  return new Uint8Array(words.buffer, 0, size);
}

/** `bytes` 分の Blob。同じチャンクを並べ、端数は切り詰めたチャンクで埋める */
function buildProbeBlob(bytes: number): Blob {
  const chunk = buildChunk(Math.min(bytes, PROBE_CHUNK_BYTES));
  const parts: BlobPart[] = [];
  let remaining = bytes;
  while (remaining > 0) {
    const size = Math.min(remaining, chunk.byteLength);
    parts.push(size === chunk.byteLength ? chunk : chunk.subarray(0, size));
    remaining -= size;
  }
  return new Blob(parts);
}

/**
 * 試験用 DB を消す。blocked (別の接続が開いている) でも待たずに進む (削除は接続が閉じた後に走る)。
 * 失敗しても reject しない (掃除の失敗で判定を変えない)。
 */
function deleteProbeDatabase(factory: IDBFactory): Promise<void> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.deleteDatabase(STORAGE_PROBE_DB_NAME);
    } catch (e) {
      console.warn('[StorageProbe] Failed to delete probe database:', e);
      resolve();
      return;
    }
    request.onsuccess = () => resolve();
    request.onblocked = () => resolve();
    request.onerror = () => {
      console.warn('[StorageProbe] Failed to delete probe database:', request.error);
      resolve();
    };
  });
}

class ProbeOpenError extends Error {
  constructor(
    readonly reason: 'open-failed' | 'blocked',
    options?: { cause?: unknown }
  ) {
    super(`Failed to open probe database: ${reason}`, options);
    this.name = 'ProbeOpenError';
  }
}

/** 試験用 DB を開く。blocked で諦めた後に開けた接続は、その場で閉じる */
function openProbeDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let gaveUp = false;
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(STORAGE_PROBE_DB_NAME, 1);
    } catch (e) {
      reject(new ProbeOpenError('open-failed', { cause: e }));
      return;
    }
    request.onupgradeneeded = () => {
      request.result.createObjectStore(PROBE_STORE);
    };
    request.onsuccess = () => {
      if (gaveUp) {
        request.result.close();
        return;
      }
      resolve(request.result);
    };
    request.onerror = () => reject(new ProbeOpenError('open-failed', { cause: request.error }));
    request.onblocked = () => {
      gaveUp = true;
      reject(new ProbeOpenError('blocked'));
    };
  });
}

/** 試験の途中の状態。上限時間を過ぎたときに、走っている transaction を abort するために持つ */
interface ProbeRun {
  transaction: IDBTransaction | null;
  timedOut: boolean;
}

function writeProbeBlob(db: IDBDatabase, bytes: number, run: ProbeRun): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([PROBE_STORE], 'readwrite');
    run.transaction = transaction;
    settleOnCommit(transaction, 'Storage probe write failed', resolve, reject);
    // put が同期で投げた例外 (容量切れを含む) は Promise の executor が reject に変える
    transaction.objectStore(PROBE_STORE).put(buildProbeBlob(bytes), PROBE_KEY);
  });
}

/** 試験の本体。上限時間とは独立に最後まで走り、後始末 (close と削除) まで済ませてから返る */
async function runProbe(factory: IDBFactory, bytes: number, run: ProbeRun): Promise<StorageProbeResult> {
  // 前回の試験の残骸を消す (削除の前に落ちると、書いた分がディスクに残る)
  await deleteProbeDatabase(factory);

  let db: IDBDatabase;
  try {
    db = await openProbeDatabase(factory);
  } catch (e) {
    const reason = e instanceof ProbeOpenError ? e.reason : 'open-failed';
    return { kind: 'inconclusive', reason, error: e };
  }

  try {
    // 開くまでに上限時間を過ぎていたら書かない (結果はもう返してある)
    if (run.timedOut) return { kind: 'inconclusive', reason: 'timeout' };
    await writeProbeBlob(db, bytes, run);
    return { kind: 'ok' };
  } catch (e) {
    if (isQuotaExceededError(e)) return { kind: 'insufficient', error: e };
    return { kind: 'inconclusive', reason: 'write-failed', error: e };
  } finally {
    run.transaction = null;
    db.close();
    await deleteProbeDatabase(factory);
  }
}

/**
 * 約 `bytes` を IndexedDB に書いて消し、書けたかを返す。reject しない。
 *
 * 上限時間を超えたら、走っている transaction を abort して `inconclusive` (`timeout`) をすぐ返す。
 * 後始末 (close と削除) は裏で続く。それ以外の結果は、試験用 DB の削除を済ませてから返す。
 */
export async function probeStorageCapacity(options: StorageProbeOptions = {}): Promise<StorageProbeResult> {
  const bytes = options.bytes ?? STORAGE_PROBE_BYTES;
  const timeoutMs = options.timeoutMs ?? STORAGE_PROBE_TIMEOUT_MS;
  const factory = options.factory ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB);
  if (!factory) return { kind: 'inconclusive', reason: 'unavailable' };

  const run: ProbeRun = { transaction: null, timedOut: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<StorageProbeResult>((resolve) => {
    timer = setTimeout(() => {
      run.timedOut = true;
      try {
        run.transaction?.abort();
      } catch {
        // 既に commit / abort 済みなら何もしない
      }
      resolve({ kind: 'inconclusive', reason: 'timeout' });
    }, timeoutMs);
  });

  const probe = runProbe(factory, bytes, run).catch(
    (e: unknown): StorageProbeResult => ({ kind: 'inconclusive', reason: 'write-failed', error: e })
  );
  try {
    return await Promise.race([probe, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
