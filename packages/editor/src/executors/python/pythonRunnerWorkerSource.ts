/**
 * Python の runner (opaque origin の sandbox iframe) が Blob の classic Worker として起動するスクリプト
 * (#649 / #719)。利用者の Python はこの Worker の中の Pyodide でだけ実行する。
 *
 * - classic Worker にしているのは、opaque origin の Blob からは module Worker を起動できないため
 *   (#719 の PoC で実測)。Pyodide は `importScripts(indexURL + 'pyodide.js')` で読む
 * - 全体を即時関数で包み、MessagePort などを global に置かない。Pyodide の `js` は Worker の
 *   globalThis なので、Python のコードからは port に触れず、runner へ結果を偽れない。Worker の
 *   `postMessage` は runner が聞いていない
 * - 起動メッセージ `{ type: 'connect', port, indexURL }` を 1 回だけ受け、以後の通信は port だけで行う
 * - stdin は runner が作った SharedArrayBuffer から `Atomics.wait` で読む (stdinChannelSource.ts)
 * - 出力はまとめて送る: 8 KiB (OUTPUT_CHUNK_CHARS) に達したとき、前回送ってから 16ms 経ったとき、
 *   タイマーの 1 tick (Python が制御を返したとき)、入力を待つ前、終わる前。同期のループの途中の出力も
 *   16ms ごとには届く。1 つのメッセージは 8 KiB 以下 (サロゲートペアの途中では切らない)
 * - 出力は予算 (stdout + stderr の文字数) を 1 文字超えたところで送るのをやめる。判定の正本は親
 * - `done` の error / result は上限 (MAX_RUNNER_TEXT_CHARS) までに切り詰める
 *
 * 文字列定数にしているのは Blob にそのまま入れるため。テストは node の vm で評価する
 * (`__tests__/pythonRunnerWorkerSource.test.ts`)。テンプレートリテラルと `${` は中で使わない。
 */

import { MAX_RUNNER_TEXT_CHARS, OUTPUT_CHUNK_CHARS } from './pythonRunnerProtocol.js';
import { STDIN_CHANNEL_SOURCE } from './stdinChannelSource.js';

const WORKER_BODY = String.raw`
  var g = self;
  var nativeSetTimeout = g.setTimeout.bind(g);
  var now = g.performance && g.performance.now ? g.performance.now.bind(g.performance) : Date.now;
  var FLUSH_INTERVAL_MS = 16;

  var port = null;
  var portPost = null;
  var indexURL = '';
  var py = null;
  var installedPackages = new Set();

  // 今の run の出力の状態
  var currentRunId = 0;
  var budget = Infinity;
  var emitted = 0;
  var budgetHit = false;
  var buffer = [];
  var bufferedChars = 0;
  var lastFlush = 0;
  var flushScheduled = false;

  function send(msg) {
    portPost.call(port, msg);
  }

  function errorMessage(error) {
    return error && error.message ? String(error.message) : String(error);
  }

  function clip(text) {
    text = String(text);
    if (text.length <= MAX_TEXT) return text;
    var marker = '\n... (truncated)';
    return text.slice(0, MAX_TEXT - marker.length) + marker;
  }

  function sendChunks(stream, text) {
    while (text.length > 0) {
      var n = Math.min(CHUNK, text.length);
      // サロゲートペアの前半で切らない
      var code = text.charCodeAt(n - 1);
      if (n < text.length && n > 1 && code >= 0xd800 && code <= 0xdbff) n--;
      send({ type: stream, runId: currentRunId, text: text.slice(0, n) });
      text = text.slice(n);
    }
  }

  function flush() {
    flushScheduled = false;
    lastFlush = now();
    var items = buffer;
    buffer = [];
    bufferedChars = 0;
    for (var i = 0; i < items.length; i++) sendChunks(items[i][0], items[i][1]);
  }

  function emit(stream, text) {
    if (budgetHit || text.length === 0) return;
    var room = budget - emitted;
    if (text.length > room) {
      // 予算を 1 文字だけ超えて送る (親がそこで超過を判定する)。以後は送らない
      text = text.slice(0, room + 1);
      budgetHit = true;
    }
    emitted += text.length;
    var last = buffer[buffer.length - 1];
    if (last && last[0] === stream) last[1] += text;
    else buffer.push([stream, text]);
    bufferedChars += text.length;
    if (budgetHit || bufferedChars >= CHUNK || now() - lastFlush >= FLUSH_INTERVAL_MS) flush();
    else if (!flushScheduled) {
      flushScheduled = true;
      nativeSetTimeout(flush, 0);
    }
  }

  // stdout / stderr の書き手。UTF-8 を文字の途中で切らずに復号する
  function streamWriter(stream) {
    var decoder = new TextDecoder();
    return {
      write: function (bytes) {
        emit(stream, decoder.decode(bytes, { stream: true }));
        return bytes.length;
      },
      end: function () {
        emit(stream, decoder.decode());
      },
    };
  }

  async function init() {
    try {
      send({ type: 'progress', stage: 'sdk', message: 'Loading Python runtime (this may take a while)...', percentage: 20 });
      g.importScripts(indexURL + 'pyodide.js');
      send({ type: 'progress', stage: 'compiler', message: 'Initializing Python interpreter...', percentage: 50 });
      py = await g.loadPyodide({ indexURL: indexURL });
      send({ type: 'progress', stage: 'ready', message: 'Python runtime ready!', percentage: 100 });
      send({ type: 'ready' });
    } catch (error) {
      send({ type: 'init-error', error: clip(errorMessage(error)) });
    }
  }

  async function installPackages(runId, requested) {
    var packages = requested.filter(function (p) {
      return !installedPackages.has(p);
    });
    if (packages.length === 0) return;
    send({ type: 'run-progress', runId: runId, message: clip('Installing packages: ' + packages.join(', ') + '...') });
    try {
      await py.loadPackage('micropip');
      await py.runPythonAsync('import micropip\nawait micropip.install(' + JSON.stringify(packages) + ')\n');
      for (var i = 0; i < packages.length; i++) installedPackages.add(packages[i]);
      emit('stdout', 'Installed: ' + packages.join(', ') + '\n');
    } catch (error) {
      // インストールに失敗しても実行は続ける (import の行で利用者に分かる形で落ちる)
      emit('stderr', 'Failed to install packages: ' + errorMessage(error) + '\n');
    }
    flush();
  }

  function displayValue(value) {
    if (value === undefined || value === null) return null;
    var text = String(value);
    // PyProxy は使い終わったら解放する
    if (typeof value.destroy === 'function') value.destroy();
    return text === 'None' ? null : clip(text);
  }

  async function run(d) {
    var runId = d.runId;
    currentRunId = runId;
    budget = d.outputBudgetChars;
    emitted = 0;
    budgetHit = false;
    buffer = [];
    bufferedChars = 0;
    lastFlush = now();
    if (!py) {
      send({ type: 'done', runId: runId, success: false, error: 'Python runtime is not initialized', result: null });
      return;
    }

    var stdout = streamWriter('stdout');
    var stderr = streamWriter('stderr');
    var pending = new Uint8Array(0);
    py.setStdout({ write: stdout.write });
    py.setStderr({ write: stderr.write });
    // isatty は付けない: stdin と stdout が tty でなければ、input() は案内文を stdout に書いて flush してから読む
    py.setStdin({
      read: function (target) {
        if (pending.length === 0) {
          pending = tcStdinRead(d.stdinBuffer, function () {
            // 案内文 (改行の無い input("名前: ")) を出してから待つ
            flush();
            send({ type: 'stdin-request', runId: runId });
          });
        }
        var n = Math.min(target.length, pending.length);
        target.set(pending.subarray(0, n));
        pending = pending.subarray(n);
        return n;
      },
    });

    await installPackages(runId, d.packages);
    send({ type: 'started', runId: runId });

    var success = true;
    var error;
    var result = null;
    try {
      result = displayValue(await py.runPythonAsync(d.code));
    } catch (e) {
      success = false;
      error = clip(errorMessage(e));
    }

    // Python 側に溜まった出力と、復号の途中のバイトを出し切ってから終わりを知らせる
    try {
      py.runPython('import sys\nsys.stdout.flush()\nsys.stderr.flush()\n');
    } catch (e) {
      // 出し切れなくても結果は返す
    }
    stdout.end();
    stderr.end();
    flush();
    var done = { type: 'done', runId: runId, success: success, result: result };
    if (error !== undefined) done.error = error;
    send(done);
  }

  function onRequest(e) {
    var d = e.data || {};
    if (d.type === 'init') init();
    else if (d.type === 'run') run(d);
  }

  function onConnect(e) {
    var d = e.data || {};
    if (port || d.type !== 'connect' || !d.port) return;
    g.removeEventListener('message', onConnect);
    port = d.port;
    portPost = port.postMessage;
    indexURL = String(d.indexURL);
    port.onmessage = onRequest;
  }
  g.addEventListener('message', onConnect);
`;

/** runner が Blob に入れて classic Worker として起動するソース */
export const PYTHON_RUNNER_WORKER_SOURCE = `(function () {
  'use strict';
  var MAX_TEXT = ${MAX_RUNNER_TEXT_CHARS};
  var CHUNK = ${OUTPUT_CHUNK_CHARS};
${STDIN_CHANNEL_SOURCE}
${WORKER_BODY}
})();
`;
