/**
 * 署名専用 token (ADR-0027) の再取得を回す (#236)。
 *
 * exam の root は封印束縛で session/start を通らないので、署名 cp の送信に要る sessionStartToken は
 * 別に取る。取得が失敗したまま放っておくと、起動時に網が落ちていたセッションは回復しても署名が
 * 全欠落する。ここでは取得を次の規律で繰り返す:
 *
 * - **同時 1 本**: 取得中に `request()` / `track()` / `notifyOnline()` が来ても 2 本目を始めない
 * - **ジッタ付き指数バックオフ・上限あり**: 失敗 n 回目の後は `min(max, base·2^(n-1))` を d として
 *   `[d/2, d]` の一様乱数だけ待つ (上限を超えない。同時に失敗した端末どうしの再試行をずらす)
 * - **`online` で早める**: 網が戻ったらバックオフを初期化し、`[0, onlineJitterMs)` の乱数だけ待って試す。
 *   教室の 100 台が同じ瞬間に online へ戻っても、取得 (Turnstile + session/start) を窓に散らす
 * - **オフラインの間は送らない**: 時刻が来ても `isOnline()` が偽なら取得せずに次のバックオフへ回す
 * - token が得られたら止まる。取得を一度も頼まれていない (exam でない) 間は `online` でも動かない
 *
 * export・保存・救出はこの成否を一切待たない (呼び出し側は fire-and-forget で使う)。
 * 時計と乱数は注入できる (unit テストは fake timers と固定の乱数で回す)。
 */

import {
  SIGNING_TOKEN_RETRY_BASE_MS,
  SIGNING_TOKEN_RETRY_MAX_MS,
  SIGNING_TOKEN_ONLINE_JITTER_MS,
} from '../config/timeouts.js';

/**
 * 失敗 `failures` 回目の後に待つ時間 (ms)。`d = min(maxMs, baseMs·2^(failures-1))` として `[d/2, d]`
 * に `random()` (`[0, 1)`) で散らす。`maxMs` を超えない。
 */
export function signingTokenBackoffMs(
  failures: number,
  random: () => number,
  baseMs: number = SIGNING_TOKEN_RETRY_BASE_MS,
  maxMs: number = SIGNING_TOKEN_RETRY_MAX_MS
): number {
  const exponent = Math.max(0, failures - 1);
  const ceiling = Math.min(maxMs, baseMs * 2 ** exponent);
  return ceiling / 2 + random() * (ceiling / 2);
}

export interface SigningTokenRetryOptions {
  /** 取得を 1 回行う。token を得て採用したら true、失敗なら false (reject も失敗として扱う) */
  acquire: () => Promise<boolean>;
  /** 使える token が既にあるか (あれば取得しない) */
  hasToken: () => boolean;
  /** 既定は `navigator.onLine` (無い環境では常に true) */
  isOnline?: () => boolean;
  /** `[0, 1)` の乱数。既定は Math.random */
  random?: () => number;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onlineJitterMs?: number;
}

/** テスト・デバッグ用の現況 */
export type SigningTokenRetryState = 'idle' | 'in-flight' | 'waiting';

export class SigningTokenRetry {
  private readonly acquire: () => Promise<boolean>;
  private readonly hasToken: () => boolean;
  private readonly isOnline: () => boolean;
  private readonly random: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly onlineJitterMs: number;

  /** 一度でも取得を頼まれたか。頼まれていない間は online でも動かない */
  private armed = false;
  private inFlight = false;
  /** 取得中に online が来た。その取得が失敗したら、長いバックオフではなく online の窓で試し直す */
  private onlineDuringFlight = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 連続した失敗の回数 (成功と online で 0 に戻す) */
  private failures = 0;
  private disposed = false;

  constructor(options: SigningTokenRetryOptions) {
    this.acquire = options.acquire;
    this.hasToken = options.hasToken;
    this.isOnline =
      options.isOnline ??
      (() => (typeof navigator === 'undefined' || navigator.onLine === undefined ? true : navigator.onLine));
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
    this.baseDelayMs = options.baseDelayMs ?? SIGNING_TOKEN_RETRY_BASE_MS;
    this.maxDelayMs = options.maxDelayMs ?? SIGNING_TOKEN_RETRY_MAX_MS;
    this.onlineJitterMs = options.onlineJitterMs ?? SIGNING_TOKEN_ONLINE_JITTER_MS;
  }

  get state(): SigningTokenRetryState {
    if (this.inFlight) return 'in-flight';
    if (this.timer !== null) return 'waiting';
    return 'idle';
  }

  /**
   * token が要る。取得中・待機中でなければ今すぐ 1 回取得する。待機中ならバックオフを飛ばさない
   * (多数のタブ・checkpoint から呼ばれてもバーストしない)。
   */
  request(): void {
    if (this.disposed) return;
    this.armed = true;
    if (this.hasToken() || this.inFlight || this.timer !== null) return;
    this.run(this.acquire);
  }

  /**
   * 外で始めた取得 (試験開始ゲート中の先行取得) を、この取得の 1 本として数える。失敗したら
   * バックオフで引き継ぐ。取得中なら何もしない (同時 1 本)。
   */
  track(attempt: Promise<boolean>): void {
    if (this.disposed) return;
    this.armed = true;
    if (this.inFlight) return;
    this.cancelTimer();
    this.run(() => attempt);
  }

  /** 網が戻った (`online` イベント)。バックオフを初期化して、窓の中の乱数の時刻に試す */
  notifyOnline(): void {
    if (this.disposed || !this.armed || this.hasToken()) return;
    if (this.inFlight) {
      this.onlineDuringFlight = true;
      return;
    }
    this.failures = 0;
    this.schedule(this.random() * this.onlineJitterMs);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  private run(start: () => Promise<boolean>): void {
    this.inFlight = true;
    this.onlineDuringFlight = false;
    let attempt: Promise<boolean>;
    try {
      attempt = start();
    } catch {
      attempt = Promise.resolve(false);
    }
    void attempt
      .catch(() => false)
      .then((ok) => {
        this.inFlight = false;
        if (this.disposed) return;
        if (ok || this.hasToken()) {
          this.failures = 0;
          return;
        }
        if (this.onlineDuringFlight) {
          this.onlineDuringFlight = false;
          this.failures = 0;
          this.schedule(this.random() * this.onlineJitterMs);
          return;
        }
        this.failures += 1;
        this.scheduleBackoff();
      });
  }

  private scheduleBackoff(): void {
    this.schedule(signingTokenBackoffMs(this.failures, this.random, this.baseDelayMs, this.maxDelayMs));
  }

  private schedule(delayMs: number): void {
    this.cancelTimer();
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.disposed || this.hasToken()) return;
      if (!this.isOnline()) {
        // オフラインの間は取得しない。online イベントが早めるので、ここでは次のバックオフへ回すだけ
        // (navigator.onLine が偽のまま戻らない環境でも、止まらずに試し続ける)
        this.failures += 1;
        this.scheduleBackoff();
        return;
      }
      this.run(this.acquire);
    }, delayMs);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
