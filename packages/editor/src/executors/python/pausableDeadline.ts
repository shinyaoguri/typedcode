/**
 * 一時停止できる期限 (#649)。
 *
 * Python の実行のタイムアウトは、入力を待っている間を数えない (受講者が考えている間に打ち切らない)。
 * Worker が入力を求めたら pause し、行を渡したら resume する。数えた時間の合計が timeoutMs に
 * 達したら onExpire を 1 回だけ呼ぶ。
 *
 * 時計は注入できる (既定は Date.now)。テストは fake timers で進める。
 */
export class PausableDeadline {
  /** まだ数えていない残り時間 (ミリ秒)。数えている間は resumedAt からの経過を引く前の値 */
  private remainingMs: number;
  /** 数えている間は resume した時刻。止まっている間は null */
  private resumedAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private finished = false;

  constructor(
    timeoutMs: number,
    private readonly onExpire: () => void,
    private readonly now: () => number = () => Date.now()
  ) {
    this.remainingMs = timeoutMs;
  }

  /** 数えているか */
  get running(): boolean {
    return this.resumedAt !== null;
  }

  /** 数え始める / 数えるのを再開する。数えている間・終わった後は何もしない */
  resume(): void {
    if (this.finished || this.resumedAt !== null) return;
    this.resumedAt = this.now();
    this.timer = setTimeout(() => this.expire(), Math.max(0, this.remainingMs));
  }

  /** 数えるのを止める。止まっている間・終わった後は何もしない */
  pause(): void {
    if (this.finished || this.resumedAt === null) return;
    this.remainingMs -= this.now() - this.resumedAt;
    this.resumedAt = null;
    this.clearTimer();
  }

  /** 期限を捨てる (以後 onExpire を呼ばない) */
  cancel(): void {
    this.finished = true;
    this.resumedAt = null;
    this.clearTimer();
  }

  private expire(): void {
    this.timer = null;
    if (this.finished) return;
    this.finished = true;
    this.resumedAt = null;
    this.onExpire();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
