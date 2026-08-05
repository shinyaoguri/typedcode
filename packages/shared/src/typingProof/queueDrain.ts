/**
 * 記録キュー (PoSW 待ち) の排出待ちポリシー (#225)。
 *
 * 固定タイムアウトで打ち切ると、単に「キューが長い」だけの正常なケースでも待ちを諦めて
 * しまう (PoSW は Worker が落ちてもメインスレッドにフォールバックして必ず完了するので、
 * 排出が終わらない主因は恒久停止ではなくキュー長)。そこで **進捗が続く限り待ち、進捗が
 * 止まったとき (stall) だけ諦める**。無限待ちを避けるため全体の上限も持つ。
 *
 * ロジックは `TypingProof` の内部状態から切り離した純関数として置く (観測は probe 経由、
 * 時計と sleep は注入可能)。
 */

/** 排出待ちの観測値。`remaining` が 0 になれば排出完了。 */
export interface QueueDrainProbe {
  /** まだチェーンに載っていないイベント数 (pending + キュー待ち)。 */
  remaining: number;
  /** チェーンに確定済みのイベント数。単調増加するので進捗判定に使う。 */
  committed: number;
}

/** 排出待ちの打ち切り理由。 */
export type QueueDrainReason =
  /** キューが空になった (content と chain が一致する) */
  | 'drained'
  /** 進捗がないまま `stallTimeoutMs` が経過した */
  | 'stalled'
  /** 進捗はあったが `maxWaitMs` を超えた */
  | 'timeout';

/** 排出待ちのオプション。時計 / sleep はテストのために注入可能。 */
export interface QueueDrainOptions {
  /** 進捗がまったく無いまま経過したら諦める時間 (既定 5000ms)。 */
  stallTimeoutMs?: number;
  /** 進捗が続いていても待ち続ける上限 (既定 60000ms)。無限待ちを防ぐ。 */
  maxWaitMs?: number;
  /** ポーリング間隔 (既定 25ms)。 */
  pollIntervalMs?: number;
  /** 残件数が変化するたびに呼ばれる (待機中であることを UI に出すため。初回も 1 度呼ぶ)。 */
  onProgress?: (remaining: number) => void;
  /** 時計 (既定 `performance.now`)。 */
  now?: () => number;
  /** 待機 (既定 `setTimeout`)。 */
  sleep?: (ms: number) => Promise<void>;
}

/** 排出待ちの結果。`drained === false` の間は content と chain が食い違いうる。 */
export interface QueueDrainResult {
  /** キューが空になったか。 */
  drained: boolean;
  /** 打ち切り時点の残件数。 */
  remaining: number;
  /** 打ち切り理由。 */
  reason: QueueDrainReason;
  /** 実際に待った時間 (ms)。 */
  waitedMs: number;
}

export const DEFAULT_QUEUE_DRAIN_STALL_MS = 5000;
export const DEFAULT_QUEUE_DRAIN_MAX_WAIT_MS = 60000;
export const DEFAULT_QUEUE_DRAIN_POLL_MS = 25;

/**
 * `probe` が `remaining === 0` を返すまで待つ。
 *
 * 進捗 = 「残件数がこれまでの最小値を下回った」または「確定イベント数が増えた」。
 * 前者だけだと export 中に新規イベントが積まれたとき (スクショ / visibility の broadcast)
 * 残件数が増減して停滞と誤判定しうるので、単調増加する確定数も進捗として数える。
 */
export async function waitForQueueDrain(
  probe: () => QueueDrainProbe,
  options: QueueDrainOptions = {}
): Promise<QueueDrainResult> {
  const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_QUEUE_DRAIN_STALL_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_QUEUE_DRAIN_MAX_WAIT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_QUEUE_DRAIN_POLL_MS;
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const start = now();
  let current = probe();
  let minRemaining = current.remaining;
  let maxCommitted = current.committed;
  let lastProgressAt = start;

  options.onProgress?.(current.remaining);

  while (current.remaining > 0) {
    const elapsed = now() - start;
    if (elapsed >= maxWaitMs) {
      return { drained: false, remaining: current.remaining, reason: 'timeout', waitedMs: elapsed };
    }
    if (now() - lastProgressAt >= stallTimeoutMs) {
      return { drained: false, remaining: current.remaining, reason: 'stalled', waitedMs: now() - start };
    }

    await sleep(pollIntervalMs);

    const next = probe();
    if (next.remaining < minRemaining || next.committed > maxCommitted) {
      minRemaining = Math.min(minRemaining, next.remaining);
      maxCommitted = Math.max(maxCommitted, next.committed);
      lastProgressAt = now();
    }
    if (next.remaining !== current.remaining) {
      options.onProgress?.(next.remaining);
    }
    current = next;
  }

  return { drained: true, remaining: 0, reason: 'drained', waitedMs: now() - start };
}
