/**
 * Python の stdin を Worker へ渡す 1 方向のチャネル (#649)。
 *
 * Pyodide の stdin のコールバックは同期で値を返す必要があるので、Pyodide を動かす Worker は
 * `Atomics.wait` で入力を待つ。メインスレッドは待たない (UI が固まる)。メインは行を貯めておき、
 * Worker が入力を求めたとき (`stdin-request`) に、領域に入るだけ書いて `Atomics.notify` で起こす。
 *
 * SharedArrayBuffer の形:
 * - 先頭 8 バイト: Int32 × 2 (状態 / 書いたバイト数)
 * - 残り: データ領域 (UTF-8 のバイト列)
 *
 * 状態は EMPTY (書き手が書いてよい) と FULL (読み手が読んでよい) の 2 つで、書き手と読み手が交互に
 * 切り替える。読み手が読み終わる前に書き手が上書きすることはない。
 *
 * バイト列で渡すのは、Pyodide の `setStdin({ read })` がバイト列を受けるため。領域より長い入力は
 * 分割して渡し、読み手の側でつながる (UTF-8 の文字の途中で切れても、Python の TextIOWrapper が
 * つなげて復号する)。
 */

const STATE = 0;
const LENGTH = 1;
const EMPTY = 0;
const FULL = 1;
const CONTROL_BYTES = 2 * Int32Array.BYTES_PER_ELEMENT;

/** データ領域の既定の大きさ (バイト) */
export const DEFAULT_STDIN_CAPACITY = 64 * 1024;

/** チャネル用の SharedArrayBuffer を作る。capacity はデータ領域のバイト数 */
export function createStdinBuffer(capacity: number = DEFAULT_STDIN_CAPACITY): SharedArrayBuffer {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(`stdin capacity must be a positive integer: ${capacity}`);
  }
  return new SharedArrayBuffer(CONTROL_BYTES + capacity);
}

function views(buffer: SharedArrayBuffer): { control: Int32Array; data: Uint8Array } {
  return {
    control: new Int32Array(buffer, 0, 2),
    data: new Uint8Array(buffer, CONTROL_BYTES),
  };
}

/** 書き手 (メインスレッド)。待たない */
export class StdinChannelWriter {
  private readonly control: Int32Array;
  private readonly data: Uint8Array;
  private readonly encoder = new TextEncoder();
  /** まだ領域に書いていない入力 (先打ちの行もここに貯まる) */
  private queue: Uint8Array[] = [];

  constructor(buffer: SharedArrayBuffer) {
    ({ control: this.control, data: this.data } = views(buffer));
  }

  /** 入力を貯める。領域にはまだ書かない (書くのは offer) */
  push(text: string): void {
    const bytes = this.encoder.encode(text);
    if (bytes.length > 0) this.queue.push(bytes);
  }

  /** 貯めていて、まだ領域に書いていないバイト数 */
  get pendingBytes(): number {
    return this.queue.reduce((sum, b) => sum + b.length, 0);
  }

  /**
   * 領域が空いていて貯めた入力があれば、領域に入るだけ書いて読み手を起こす。書いたら true。
   * 読み手がまだ読んでいない (FULL) あいだは書かない
   */
  offer(): boolean {
    if (Atomics.load(this.control, STATE) !== EMPTY || this.queue.length === 0) return false;
    let written = 0;
    while (this.queue.length > 0 && written < this.data.length) {
      const head = this.queue[0] as Uint8Array;
      const n = Math.min(head.length, this.data.length - written);
      this.data.set(head.subarray(0, n), written);
      written += n;
      if (n === head.length) this.queue.shift();
      else this.queue[0] = head.subarray(n);
    }
    Atomics.store(this.control, LENGTH, written);
    Atomics.store(this.control, STATE, FULL);
    Atomics.notify(this.control, STATE);
    return true;
  }
}

/** 読み手 (Worker)。書き手が書くまで `Atomics.wait` で待つ */
export class StdinChannelReader {
  private readonly control: Int32Array;
  private readonly data: Uint8Array;

  constructor(buffer: SharedArrayBuffer) {
    ({ control: this.control, data: this.data } = views(buffer));
  }

  /**
   * 書かれたバイト列を取り出して領域を空ける。まだ書かれていなければ、onWait を 1 回呼んでから
   * 書かれるまで待つ (onWait で書き手に入力を求める)
   */
  read(onWait?: () => void): Uint8Array {
    if (Atomics.load(this.control, STATE) !== FULL) {
      onWait?.();
      while (Atomics.load(this.control, STATE) !== FULL) {
        Atomics.wait(this.control, STATE, EMPTY);
      }
    }
    const length = Atomics.load(this.control, LENGTH);
    // slice は共有しない ArrayBuffer への写しを作る (領域を空けたあと書き手が上書きしてよい)
    const bytes = this.data.slice(0, length);
    Atomics.store(this.control, STATE, EMPTY);
    return bytes;
  }
}
