// Python runner 隔離の PoC (#719 / #650): runner (iframe) の中で起こす Worker。probe.js と連結して
// Blob の module Worker にする。Pyodide を読んで Python を走らせ、stdin は runner が作った
// SharedArrayBuffer から Atomics.wait で読む (packages/editor/src/executors/python/stdinChannel.ts と同じ形)。
//
// runner への返信は、起動時に受け取った MessagePort だけで行う。port はモジュールのスコープにあり、
// globalThis (= Pyodide の `js`) からは届かないので、Python のコードは結果を偽れない。

let port = null;
let py = null;

const STATE = 0;
const LENGTH = 1;
const EMPTY = 0;
const FULL = 1;

function readStdin(sab, onWait) {
  const control = new Int32Array(sab, 0, 2);
  const data = new Uint8Array(sab, 8);
  if (Atomics.load(control, STATE) !== FULL) {
    onWait();
    while (Atomics.load(control, STATE) !== FULL) Atomics.wait(control, STATE, EMPTY);
  }
  const length = Atomics.load(control, LENGTH);
  const bytes = data.slice(0, length);
  Atomics.store(control, STATE, EMPTY);
  return bytes;
}

function send(msg) {
  port.postMessage(msg);
}

async function init(indexURL) {
  const t0 = performance.now();
  try {
    // classic Worker では importScripts、module Worker では import() で読む
    // (module Worker の importScripts は TypeError を投げる)
    let load;
    try {
      importScripts(`${indexURL}pyodide.js`);
      load = self.loadPyodide;
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      load = (await import(`${indexURL}pyodide.mjs`)).loadPyodide;
    }
    py = await load({ indexURL });
    send({ type: 'py-ready', ms: Math.round(performance.now() - t0) });
  } catch (e) {
    send({ type: 'init-error', error: String(e?.message ?? e) });
  }
}

async function run(code, sab) {
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const writer = (type) => ({
    write(buffer) {
      const text = decoders[type].decode(buffer, { stream: true });
      if (text) send({ type, text });
      return buffer.length;
    },
  });
  let pending = new Uint8Array(0);
  py.setStdout(writer('stdout'));
  py.setStderr(writer('stderr'));
  py.setStdin({
    read(buffer) {
      if (pending.length === 0) pending = readStdin(sab, () => send({ type: 'stdin-request' }));
      const n = Math.min(buffer.length, pending.length);
      buffer.set(pending.subarray(0, n));
      pending = pending.subarray(n);
      return n;
    },
  });
  let success = true;
  let error;
  try {
    await py.runPythonAsync(code);
  } catch (e) {
    success = false;
    error = String(e?.message ?? e);
  }
  try {
    py.runPython('import sys\nsys.stdout.flush()\nsys.stderr.flush()\n');
  } catch {
    // 出し切れなくても結果は返す
  }
  send({ type: 'done', success, error });
}

async function onRequest(event) {
  const d = event.data;
  if (d.type === 'probe') send({ type: 'probe-result', scope: 'worker', result: await tcProbe(d.dbName) });
  else if (d.type === 'init') await init(d.indexURL);
  else if (d.type === 'run') await run(d.code, d.sab);
  else if (d.type === 'sab-check') {
    // runner が親から受け取った (受け取れなかった) SAB をそのまま渡してくる
    send({ type: 'sab-check-result', received: Object.prototype.toString.call(d.sab) });
  }
}

self.onmessage = (event) => {
  const d = event.data;
  if (port || !d || d.type !== 'connect') return;
  port = d.port;
  port.onmessage = (e) => void onRequest(e);
  send({ type: 'connected' });
};
