/**
 * sandbox iframe の srcdoc (runner) を組み立てる (#290 / ADR-0041)。
 *
 * iframe は `sandbox="allow-scripts"` だけを持つ (allow-same-origin なし = opaque origin)。
 * runner はこの中の inline script で、親から実行要求を 1 回だけ受けて Blob Worker を作り、
 * Worker の出力を親へ中継する。iframe で直接実行しないのは、同じプロセスで動く同期ループが
 * 親のメインスレッドごと固めうるため (Worker なら iframe の除去で確実に止まる)。
 *
 * CSP (meta): 既定はすべて禁止し、runner の inline script・Worker 内の AsyncFunction
 * ('unsafe-eval')・Blob Worker (blob:) だけを許す。`connect-src 'none'` で fetch / XHR /
 * WebSocket による外部送信の経路を作らない。srcdoc は親の CSP も継承するので、親に CSP を
 * 入れるときは blob: Worker と 'unsafe-eval' を塞がないこと (#411)。
 */

import { SANDBOX_WORKER_SOURCE } from './workerSource.js';

/** runner の CSP。ここに許可を足すときは ADR-0041 を更新する */
export const SANDBOX_RUNNER_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'";

/** iframe の sandbox 属性。`allow-same-origin` を足さない (足すと親の保存領域と DOM に届く) */
export const SANDBOX_IFRAME_TOKENS = 'allow-scripts';

/** JS の文字列リテラルとして埋め込む。`</script>` などで inline script が閉じないよう `<` を逃がす */
export function scriptLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
}

/**
 * runner の本体 (inline script)。先頭で RUN_ID と WORKER_SOURCE を定義してから使う。
 * 親 (parent) からの `{ type: 'run', runId, code, outputBudgetChars }` を 1 回だけ受ける。
 * Worker 自身の postMessage は聞かない (ユーザーコードが偽の結果を送れないよう、受け取るのは
 * 起動時に渡した MessagePort だけ)。
 */
export const RUNNER_SCRIPT = `(function () {
  var started = false;
  function post(msg) {
    msg.runId = RUN_ID;
    parent.postMessage(msg, '*');
  }
  addEventListener('message', function (e) {
    if (e.source !== parent || started) return;
    var d = e.data;
    if (!d || d.type !== 'run' || d.runId !== RUN_ID || typeof d.code !== 'string') return;
    started = true;
    var worker;
    try {
      var url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
      worker = new Worker(url);
    } catch (err) {
      post({ type: 'fatal', message: 'Failed to start the code runner: ' + String((err && err.message) || err) });
      return;
    }
    var channel = new MessageChannel();
    channel.port1.onmessage = function (m) {
      var x = m.data;
      if (!x || typeof x !== 'object') return;
      if ((x.type === 'stdout' || x.type === 'stderr') && typeof x.text === 'string') {
        post({ type: x.type, text: x.text });
      } else if (x.type === 'done') {
        var ok = x.outcome === 'success';
        post({ type: 'done', outcome: ok ? 'success' : 'failure', exitCode: ok ? 0 : 1 });
      }
    };
    worker.onerror = function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      post({ type: 'fatal', message: 'The code runner crashed: ' + String((ev && ev.message) || 'worker error') });
    };
    worker.postMessage({ code: d.code, outputBudgetChars: d.outputBudgetChars, port: channel.port2 }, [channel.port2]);
  });
  post({ type: 'ready' });
})();`;

/** 1 回の実行に使う srcdoc を作る。runId は親が run ごとに作る推測しにくい文字列 */
export function buildRunnerSrcdoc(runId: string, workerSource: string = SANDBOX_WORKER_SOURCE): string {
  const script = `var RUN_ID = ${scriptLiteral(runId)};\nvar WORKER_SOURCE = ${scriptLiteral(workerSource)};\n${RUNNER_SCRIPT}`;
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_RUNNER_CSP}">` +
    `</head><body><script>${script}</script></body></html>`
  );
}
