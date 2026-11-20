// Python runner 隔離の PoC (#719 / #650): iframe の中の runner。probe.js と連結して使う。
// srcdoc では先頭で RUN_ID を定義する。URL で開く (別 origin の) runner は location.hash から読む。
//
// - 親から { type, runId, ... } を受け、runId が違う・source が親でないものは捨てる
// - Worker への要求と Worker からの返信は MessageChannel で中継する (Worker の postMessage は聞かない)
// - stdin: runner が SharedArrayBuffer を作り、親から届いた行を書いて Worker を起こす
//   (親の SAB は opaque origin へ渡せない前提の構成 = #719 の推奨順 2)

(() => {
  const runId = typeof RUN_ID === 'string' ? RUN_ID : decodeURIComponent(location.hash.slice(1));
  let worker = null;
  let port = null;
  let sab = null;
  let queue = [];
  let closed = false;
  const encoder = new TextEncoder();

  function post(msg) {
    msg.runId = runId;
    parent.postMessage(msg, '*');
  }

  // 親から届いた入力を、Worker の領域が空いていれば書いて起こす (stdinChannel.ts の StdinChannelWriter と同じ)
  function offer() {
    if (!sab) return false;
    const control = new Int32Array(sab, 0, 2);
    const data = new Uint8Array(sab, 8);
    if (Atomics.load(control, 0) !== 0) return false;
    if (queue.length === 0 && !closed) return false;
    let written = 0;
    while (queue.length > 0 && written < data.length) {
      const head = queue[0];
      const n = Math.min(head.length, data.length - written);
      data.set(head.subarray(0, n), written);
      written += n;
      if (n === head.length) queue.shift();
      else queue[0] = head.subarray(n);
    }
    Atomics.store(control, 1, written);
    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0);
    return true;
  }

  function start(workerSource, workerType) {
    try {
      const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
      worker = new Worker(url, { type: workerType === 'classic' ? 'classic' : 'module' });
    } catch (e) {
      post({ type: 'fatal', message: `worker: ${e?.name}: ${e?.message}` });
      return;
    }
    worker.onerror = (ev) => {
      ev.preventDefault?.();
      post({ type: 'fatal', message: `worker error: ${ev?.message ?? 'unknown'}` });
    };
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = (m) => {
      const x = m.data;
      if (x?.type === 'stdin-request') offer();
      post(x);
    };
    worker.postMessage({ type: 'connect', port: channel.port2 }, [channel.port2]);
  }

  addEventListener('messageerror', () => post({ type: 'messageerror' }));
  addEventListener('message', async (e) => {
    if (e.source !== parent) return;
    const d = e.data;
    if (!d || d.runId !== runId) return;
    switch (d.type) {
      case 'start':
        start(d.workerSource, d.workerType);
        break;
      case 'probe':
        post({ type: 'probe-result', scope: 'window', result: await tcProbe(d.dbName) });
        port?.postMessage({ type: 'probe', dbName: d.dbName });
        break;
      case 'sab':
        // 親の SAB がここまで届くか (届かなければ messageerror が先に出る)
        post({ type: 'sab-result', received: Object.prototype.toString.call(d.sab) });
        port?.postMessage({ type: 'sab-check', sab: d.sab });
        break;
      case 'init':
        port.postMessage({ type: 'init', indexURL: d.indexURL });
        break;
      case 'run':
        try {
          sab = new SharedArrayBuffer(8 + (d.capacity ?? 64 * 1024));
        } catch (err) {
          post({ type: 'fatal', message: `runner SAB: ${err?.name}` });
          return;
        }
        queue = [];
        closed = false;
        port.postMessage({ type: 'run', code: d.code, sab });
        break;
      case 'stdin': {
        const bytes = encoder.encode(d.text);
        if (bytes.length > 0 && !closed) queue.push(bytes);
        offer();
        break;
      }
      case 'eof':
        closed = true;
        offer();
        break;
    }
  });
  post({ type: 'ready' });
})();
