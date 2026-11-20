// Python runner 隔離の PoC (#719 / #650)。実行環境 (iframe の window と Worker) で、隔離の効き具合を測る。
// runner.js (iframe) と worker.js (Worker) の先頭に連結して使う。本実装では使わない計測専用のコード。

// biome-ignore lint/correctness/noUnusedVariables: runner.js / worker.js と連結して使う
async function tcProbe(dbName) {
  const r = { origin: String(self.origin), crossOriginIsolated: self.crossOriginIsolated === true };
  try {
    new SharedArrayBuffer(8);
    r.sab = 'ok';
  } catch (e) {
    r.sab = `throw: ${e.name}`;
  }
  try {
    const ia = new Int32Array(new SharedArrayBuffer(4));
    r.atomicsWait = Atomics.wait(ia, 0, 0, 1);
  } catch (e) {
    r.atomicsWait = `throw: ${e.name}`;
  }
  r.idbOpen = await new Promise((resolve) => {
    try {
      const q = indexedDB.open(dbName);
      q.onsuccess = () => {
        const db = q.result;
        resolve(`success: stores=${JSON.stringify(Array.from(db.objectStoreNames))}`);
        db.close();
      };
      q.onerror = () => resolve(`error: ${q.error?.name}`);
      q.onblocked = () => resolve('blocked');
    } catch (e) {
      resolve(`throw: ${e.name}`);
    }
  });
  try {
    const list = await indexedDB.databases();
    r.idbDatabases = JSON.stringify(list.map((d) => d.name));
  } catch (e) {
    r.idbDatabases = `throw: ${e.name}`;
  }
  if (typeof window !== 'undefined') {
    try {
      r.localStorage = `ok: length=${window.localStorage.length}`;
    } catch (e) {
      r.localStorage = `throw: ${e.name}`;
    }
    try {
      r.parentDocument = window.parent.document ? 'reachable' : 'null';
    } catch (e) {
      r.parentDocument = `throw: ${e.name}`;
    }
  }
  return r;
}
