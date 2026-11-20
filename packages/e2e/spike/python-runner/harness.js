// Python runner 隔離の PoC (#719 / #650): 親 (editor と同じ origin) に注入する計測用の操作口。
// spec が page.addScriptTag で入れて、window.__spike を page.evaluate から呼ぶ。
// runner の srcdoc は spec が渡す probe.js / runner.js / worker.js のソースから組み立てる。

(() => {
  const sources = { probe: '', runner: '', worker: '' };
  const runners = new Map();

  function literal(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
  }

  function buildSrcdoc(runId, csp) {
    const meta = csp ? `<meta http-equiv="Content-Security-Policy" content="${csp}">` : '';
    const script = `var RUN_ID = ${literal(runId)};\n${sources.probe}\n${sources.runner}`;
    return `<!doctype html><html><head><meta charset="utf-8">${meta}</head><body><script>${script}</script></body></html>`;
  }

  function waitFor(handle, predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const found = handle.log.find(predicate);
      if (found) return resolve(found);
      const timer = setTimeout(() => {
        handle.waiters.delete(check);
        reject(new Error(`timeout waiting; log=${JSON.stringify(handle.log.map((m) => m.type))}`));
      }, timeoutMs);
      function check(msg) {
        if (!predicate(msg)) return;
        clearTimeout(timer);
        handle.waiters.delete(check);
        resolve(msg);
      }
      handle.waiters.add(check);
    });
  }

  window.__spike = {
    configure(next) {
      Object.assign(sources, next);
    },

    async seedParentDb(name) {
      return await new Promise((resolve, reject) => {
        const q = indexedDB.open(name, 1);
        q.onupgradeneeded = () => q.result.createObjectStore('events', { keyPath: 'id' });
        q.onsuccess = () => {
          const db = q.result;
          const tx = db.transaction('events', 'readwrite');
          tx.objectStore('events').put({ id: 1, payload: 'original' });
          tx.oncomplete = () => {
            db.close();
            resolve('seeded');
          };
          tx.onerror = () => reject(tx.error);
        };
        q.onerror = () => reject(q.error);
      });
    },

    async readParentDb(name) {
      return await new Promise((resolve, reject) => {
        const q = indexedDB.open(name);
        q.onsuccess = () => {
          const db = q.result;
          if (!db.objectStoreNames.contains('events')) {
            db.close();
            return resolve(null);
          }
          const get = db.transaction('events').objectStore('events').getAll();
          get.onsuccess = () => {
            db.close();
            resolve(get.result);
          };
        };
        q.onerror = () => reject(q.error);
      });
    },

    async parentDbNames() {
      return (await indexedDB.databases()).map((d) => d.name);
    },

    /**
     * runner の iframe を作り、ready を待つ。
     * opts: { sandbox?: string|null, allow?: string, csp?: string, url?: string, origin?: string }
     * url を渡すと srcdoc でなく URL で開く (別 origin の runner)。origin は期待する送り手の origin
     */
    async create(opts = {}) {
      const runId = crypto.randomUUID();
      const iframe = document.createElement('iframe');
      if (opts.sandbox !== null) iframe.setAttribute('sandbox', opts.sandbox ?? 'allow-scripts');
      if (opts.allow) iframe.setAttribute('allow', opts.allow);
      iframe.hidden = true;
      const handle = { runId, iframe, log: [], waiters: new Set(), opts, rejected: 0 };
      handle.listener = (e) => {
        if (e.source !== iframe.contentWindow) return;
        const expectedOrigin = opts.origin ?? 'null';
        if (e.origin !== expectedOrigin) {
          handle.rejected++;
          return;
        }
        const d = e.data;
        if (!d || typeof d !== 'object' || d.runId !== runId || typeof d.type !== 'string') {
          handle.rejected++;
          return;
        }
        handle.log.push(d);
        for (const w of [...handle.waiters]) w(d);
      };
      window.addEventListener('message', handle.listener);
      if (opts.url) iframe.src = `${opts.url}#${encodeURIComponent(runId)}`;
      else iframe.srcdoc = buildSrcdoc(runId, opts.csp);
      document.body.appendChild(iframe);
      runners.set(runId, handle);
      await waitFor(handle, (m) => m.type === 'ready', 10_000);
      this.send(runId, {
        type: 'start',
        workerType: opts.workerType ?? 'module',
        workerSource: `${sources.probe}\n${sources.worker}`,
      });
      await waitFor(handle, (m) => m.type === 'connected' || m.type === 'fatal', 10_000);
      return runId;
    },

    send(runId, msg) {
      const handle = runners.get(runId);
      const target = handle.opts.url ? new URL(handle.opts.url).origin : '*';
      handle.iframe.contentWindow.postMessage({ ...msg, runId }, target);
    },

    log(runId) {
      return runners.get(runId).log;
    },

    rejected(runId) {
      return runners.get(runId).rejected;
    },

    async probe(runId, dbName) {
      const handle = runners.get(runId);
      this.send(runId, { type: 'probe', dbName });
      const win = await waitFor(handle, (m) => m.type === 'probe-result' && m.scope === 'window', 10_000);
      const wrk = await waitFor(handle, (m) => m.type === 'probe-result' && m.scope === 'worker', 10_000);
      return { window: win.result, worker: wrk.result };
    },

    /** 親が作った SAB を runner へ postMessage し、runner と Worker で受け取れたかを返す */
    async sendParentSab(runId) {
      const handle = runners.get(runId);
      const sab = new SharedArrayBuffer(16);
      let postError = null;
      try {
        handle.iframe.contentWindow.postMessage({ type: 'sab', runId, sab }, '*');
      } catch (e) {
        postError = `${e.name}: ${e.message}`;
      }
      const result = await waitFor(handle, (m) => m.type === 'sab-result' || m.type === 'messageerror', 5_000).catch(
        (e) => ({ type: 'timeout', message: String(e.message) })
      );
      const worker = await waitFor(handle, (m) => m.type === 'sab-check-result', 2_000).catch(() => null);
      return { postError, runner: result, worker };
    },

    async init(runId, indexURL) {
      const handle = runners.get(runId);
      const t0 = performance.now();
      this.send(runId, { type: 'init', indexURL });
      const m = await waitFor(
        handle,
        (x) => x.type === 'py-ready' || x.type === 'init-error' || x.type === 'fatal',
        120_000
      );
      return { ...m, wallMs: Math.round(performance.now() - t0) };
    },

    run(runId, code) {
      const handle = runners.get(runId);
      handle.log = handle.log.filter((m) => m.type === 'connected' || m.type === 'py-ready');
      this.send(runId, { type: 'run', code });
    },

    stdin(runId, text) {
      this.send(runId, { type: 'stdin', text });
    },

    eof(runId) {
      this.send(runId, { type: 'eof' });
    },

    waitFor(runId, type, timeoutMs = 60_000) {
      return waitFor(runners.get(runId), (m) => m.type === type || m.type === 'fatal', timeoutMs);
    },

    output(runId) {
      const log = runners.get(runId).log;
      return {
        stdout: log
          .filter((m) => m.type === 'stdout')
          .map((m) => m.text)
          .join(''),
        stderr: log
          .filter((m) => m.type === 'stderr')
          .map((m) => m.text)
          .join(''),
        done: log.find((m) => m.type === 'done') ?? null,
        stdinRequests: log.filter((m) => m.type === 'stdin-request').length,
      };
    },

    /** 停止: iframe ごと捨てる (中の Worker も止まる) */
    destroy(runId) {
      const handle = runners.get(runId);
      window.removeEventListener('message', handle.listener);
      handle.iframe.remove();
      runners.delete(runId);
    },

    /** ms のあいだ親のタイマーの最大の遅れを測り、途中で親の IndexedDB に書く */
    async responsiveness(ms, dbName) {
      let last = performance.now();
      let maxGap = 0;
      let ticks = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
        ticks++;
      }, 10);
      const t0 = performance.now();
      const write = await new Promise((resolve) => {
        const q = indexedDB.open(dbName);
        q.onsuccess = () => {
          const db = q.result;
          const tx = db.transaction('events', 'readwrite');
          tx.objectStore('events').put({ id: 2, payload: 'written-during-loop' });
          tx.oncomplete = () => {
            db.close();
            resolve(Math.round(performance.now() - t0));
          };
        };
      });
      await new Promise((r) => setTimeout(r, ms));
      clearInterval(timer);
      return { maxGapMs: Math.round(maxGap), ticks, idbWriteMs: write };
    },
  };
})();
