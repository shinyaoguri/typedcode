/**
 * Python の runner (sandbox iframe の srcdoc) を組み立てる (#719 / #650)。
 *
 * iframe は `sandbox="allow-scripts"` (allow-same-origin なし = opaque origin) と
 * `allow="cross-origin-isolated"` を持つ。opaque origin なので、実行コードから editor の IndexedDB
 * (proof)・localStorage・親 DOM に届かない。`allow="cross-origin-isolated"` は、runner と Worker で
 * SharedArrayBuffer と `Atomics.wait` (同期の `input()`) を使うため (親は COOP / COEP で
 * cross-origin isolated。付けないと runner は isolated にならない = #719 の PoC)。
 *
 * runner はこの中の inline script で、Blob の classic Worker (pythonRunnerWorkerSource.ts) を起こし、
 * 親と Worker のメッセージを中継する:
 * - 親からのメッセージは `e.source === parent`・`e.origin === 親の origin`・runnerId の一致・type の
 *   許可リストと型を確かめ、外れたものは捨てる。親へは親の origin を宛先にして送る
 * - cross-origin isolated でなければ Worker を作らず `runner-ready { crossOriginIsolated: false }` だけ
 *   返す。親はそれを見て実行しない (fail closed。同じ origin の Worker での実行へは戻らない)
 * - stdin の SharedArrayBuffer は runner が run ごとに作って Worker と共有する。親からの `stdin` の行は
 *   ここに貯め、Worker が入力を求めたら書く。書けなかった (貯めが空) ときだけ `stdin-request` を親へ返す
 *
 * CSP (meta): 既定はすべて禁止し、runner の inline script・Wasm のコンパイル ('wasm-unsafe-eval')・
 * Blob の Worker・Pyodide の配信元からのスクリプトを許す。`'unsafe-eval'` は付けない (Python から
 * `js.eval` で runner の中身に触れさせない)。通信 (connect-src) は Pyodide の配信元と、micropip が
 * import から拾ったパッケージを入れるための PyPI だけ。srcdoc は親の CSP (`config/deliveryHeaders.ts`) も
 * 継承するので、親の CSP でこれらを塞がないこと (#411。親は同じ定数から許可を作る)。
 */

import { scriptLiteral } from '../sandbox/runnerDocument.js';
import { PYODIDE_CDN_URL, PYPI_ORIGINS } from './pythonRunnerProtocol.js';
import { PYTHON_RUNNER_WORKER_SOURCE } from './pythonRunnerWorkerSource.js';
import { STDIN_CHANNEL_SOURCE } from './stdinChannelSource.js';

/** runner の CSP。ここに許可を足すときは ADR を更新する */
export const PYTHON_RUNNER_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'wasm-unsafe-eval' blob: ${PYODIDE_CDN_URL}`,
  'worker-src blob:',
  `connect-src ${[PYODIDE_CDN_URL, ...PYPI_ORIGINS].join(' ')}`,
].join('; ');

/** iframe の sandbox 属性。`allow-same-origin` を足さない (足すと親の保存領域と DOM に届く) */
export const PYTHON_RUNNER_IFRAME_TOKENS = 'allow-scripts';

/** iframe の allow 属性 (Permissions Policy)。runner で SharedArrayBuffer を使うため */
export const PYTHON_RUNNER_IFRAME_ALLOW = 'cross-origin-isolated';

/** stdin のデータ領域の大きさ (バイト) */
export const STDIN_CAPACITY_BYTES = 64 * 1024;

/**
 * runner の本体 (inline script)。先頭で RUNNER_ID / PARENT_ORIGIN / INDEX_URL / WORKER_SOURCE /
 * STDIN_CAPACITY を定義し、STDIN_CHANNEL_SOURCE を連結してから使う。
 */
export const PYTHON_RUNNER_SCRIPT = String.raw`
  var worker = null;
  var port = null;
  var runId = 0;
  var writer = null;
  var received = 0;

  function post(msg) {
    msg.runnerId = RUNNER_ID;
    parent.postMessage(msg, PARENT_ORIGIN);
  }

  function isRunId(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  }

  function isolated() {
    return self.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';
  }

  function relay(m) {
    var x = m.data;
    if (!x || typeof x !== 'object' || typeof x.type !== 'string') return;
    // 入力があればここで渡す。渡せなかったときだけ親に入力を求める
    if (x.type === 'stdin-request') {
      if (x.runId !== runId || !writer || writer.offer()) return;
      post({ type: 'stdin-request', runId: runId, received: received });
      return;
    }
    var copy = {};
    for (var key in x) {
      if (Object.prototype.hasOwnProperty.call(x, key)) copy[key] = x[key];
    }
    post(copy);
  }

  function start() {
    try {
      var url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
      worker = new Worker(url);
    } catch (err) {
      post({ type: 'fatal', message: 'Failed to start the Python runner: ' + String((err && err.message) || err) });
      return;
    }
    worker.onerror = function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      post({ type: 'fatal', message: 'The Python runner crashed: ' + String((ev && ev.message) || 'worker error') });
    };
    var channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = relay;
    worker.postMessage({ type: 'connect', port: channel.port2, indexURL: INDEX_URL }, [channel.port2]);
  }

  function onParentMessage(e) {
    if (e.source !== parent || e.origin !== PARENT_ORIGIN || !port) return;
    var d = e.data;
    if (!d || typeof d !== 'object' || d.runnerId !== RUNNER_ID) return;
    switch (d.type) {
      case 'init':
        port.postMessage({ type: 'init' });
        return;
      case 'run': {
        var okPackages = Array.isArray(d.packages) && d.packages.every(function (p) {
          return typeof p === 'string';
        });
        if (!isRunId(d.runId) || typeof d.code !== 'string' || !okPackages) return;
        if (typeof d.outputBudgetChars !== 'number' || !(d.outputBudgetChars > 0)) return;
        runId = d.runId;
        received = 0;
        var stdinBuffer = tcCreateStdinBuffer(STDIN_CAPACITY);
        writer = tcStdinWriter(stdinBuffer);
        port.postMessage({
          type: 'run',
          runId: runId,
          code: d.code,
          packages: d.packages.slice(),
          outputBudgetChars: d.outputBudgetChars,
          stdinBuffer: stdinBuffer,
        });
        return;
      }
      case 'stdin':
        if (d.runId !== runId || !writer || typeof d.text !== 'string') return;
        received++;
        writer.push(d.text);
        writer.offer();
        return;
      case 'stdin-eof':
        if (d.runId !== runId || !writer) return;
        received++;
        writer.close();
        writer.offer();
        return;
    }
  }

  addEventListener('message', onParentMessage);
  if (isolated()) start();
  post({ type: 'runner-ready', crossOriginIsolated: isolated() && port !== null });
`;

export interface PythonRunnerSrcdocOptions {
  /** runner ごとの推測しにくい ID (親が作る) */
  runnerId: string;
  /** 親 (エディタ) の origin。runner は宛先と受信の検査に使う */
  parentOrigin: string;
  /** Worker のソース (テストで差し替える) */
  workerSource?: string;
}

/** runner の srcdoc を作る */
export function buildPythonRunnerSrcdoc(options: PythonRunnerSrcdocOptions): string {
  const script =
    '(function () {\n' +
    `var RUNNER_ID = ${scriptLiteral(options.runnerId)};\n` +
    `var PARENT_ORIGIN = ${scriptLiteral(options.parentOrigin)};\n` +
    `var INDEX_URL = ${scriptLiteral(PYODIDE_CDN_URL)};\n` +
    `var STDIN_CAPACITY = ${STDIN_CAPACITY_BYTES};\n` +
    `var WORKER_SOURCE = ${scriptLiteral(options.workerSource ?? PYTHON_RUNNER_WORKER_SOURCE)};\n` +
    `${STDIN_CHANNEL_SOURCE}\n${PYTHON_RUNNER_SCRIPT}\n})();`;
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${PYTHON_RUNNER_CSP}">` +
    `</head><body><script>${script}</script></body></html>`
  );
}
