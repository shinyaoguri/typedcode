/**
 * Python の stdin を Worker へ渡す 1 方向のチャネル (#649 / #719) のソース (文字列定数)。
 *
 * Pyodide の stdin のコールバックは同期で値を返す必要があるので、Pyodide を動かす Worker は
 * `Atomics.wait` で入力を待つ。書き手は Worker を作った runner (opaque origin の sandbox iframe) で、
 * 親 (エディタ) から postMessage で届いた行を貯めておき、Worker が入力を求めたとき (`stdin-request`) に
 * 領域に入るだけ書いて `Atomics.notify` で起こす。SharedArrayBuffer は runner が作って Worker と
 * 共有し、親とは共有しない (親の SAB は opaque origin へ渡せない = #719 の PoC)。
 *
 * runner (srcdoc の inline script) と Worker (Blob の classic Worker) の両方に連結して使うので、
 * 文字列定数にしている (バンドラの変換を受けない)。テストは node の vm で評価して確かめる
 * (`__tests__/stdinChannelSource.test.ts`)。テンプレートリテラルと `${` は中で使わない。
 *
 * SharedArrayBuffer の形:
 * - 先頭 8 バイト: Int32 × 2 (状態 / 書いたバイト数)
 * - 残り: データ領域 (UTF-8 のバイト列)
 *
 * 状態は EMPTY (0。書き手が書いてよい) と FULL (1。読み手が読んでよい) の 2 つで、書き手と読み手が
 * 交互に切り替える。読み手が読み終わる前に書き手が上書きすることはない。領域より長い入力は分割して
 * 渡し、読み手の側でつながる (UTF-8 の文字の途中で切れても、Python の TextIOWrapper がつなげて復号する)。
 * 長さ 0 のバイト列は EOF (書き手が close 済みで、貯めを渡し切った)。
 *
 * 定義する関数:
 * - `tcCreateStdinBuffer(capacity)`: データ領域が capacity バイトの SharedArrayBuffer
 * - `tcStdinWriter(buffer)`: 書き手 `{ push(text), close(), offer() }`。offer は書いたら true
 * - `tcStdinRead(buffer, onWait)`: 読み手。書かれていなければ onWait を 1 回呼んでから待つ
 */
export const STDIN_CHANNEL_SOURCE = String.raw`
  var TC_STDIN_CONTROL_BYTES = 8;

  function tcCreateStdinBuffer(capacity) {
    return new SharedArrayBuffer(TC_STDIN_CONTROL_BYTES + capacity);
  }

  function tcStdinWriter(buffer) {
    var control = new Int32Array(buffer, 0, 2);
    var data = new Uint8Array(buffer, TC_STDIN_CONTROL_BYTES);
    var encoder = new TextEncoder();
    var queue = [];
    var closed = false;
    return {
      push: function (text) {
        if (closed) return;
        var bytes = encoder.encode(text);
        if (bytes.length > 0) queue.push(bytes);
      },
      close: function () {
        closed = true;
      },
      offer: function () {
        if (Atomics.load(control, 0) !== 0) return false;
        if (queue.length === 0 && !closed) return false;
        var written = 0;
        while (queue.length > 0 && written < data.length) {
          var head = queue[0];
          var n = Math.min(head.length, data.length - written);
          data.set(head.subarray(0, n), written);
          written += n;
          if (n === head.length) queue.shift();
          else queue[0] = head.subarray(n);
        }
        Atomics.store(control, 1, written);
        Atomics.store(control, 0, 1);
        Atomics.notify(control, 0);
        return true;
      },
    };
  }

  function tcStdinRead(buffer, onWait) {
    var control = new Int32Array(buffer, 0, 2);
    var data = new Uint8Array(buffer, TC_STDIN_CONTROL_BYTES);
    if (Atomics.load(control, 0) !== 1) {
      if (onWait) onWait();
      while (Atomics.load(control, 0) !== 1) Atomics.wait(control, 0, 0);
    }
    var length = Atomics.load(control, 1);
    // slice は共有しない ArrayBuffer への写しを作る (領域を空けたあと書き手が上書きしてよい)
    var bytes = data.slice(0, length);
    Atomics.store(control, 0, 0);
    return bytes;
  }
`;
