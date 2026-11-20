/**
 * Python runner 隔離の PoC (#719 / #650)。検査ではなく計測。結果は `[spike]` の行で標準出力に出す。
 * 親 (editor と同じ origin) から sandbox iframe + Blob module Worker の runner を作り、
 * 1) 隔離の効き具合 (crossOriginIsolated / SAB / Atomics.wait / IndexedDB) 2) Pyodide の読み込みと実行
 * 3) 親の SAB の受け渡しと MessagePort 経由の stdin 4) 停止・再実行・無限ループ中の親の応答
 * 5) 別 origin の runner を測る。実行: packages/e2e で `npx playwright test -c playwright.spike.config.ts`
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

const here = join(dirname(fileURLToPath(import.meta.url)), 'python-runner');
const src = (name: string) => readFileSync(join(here, name), 'utf8');

const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v0.27.0/full/';
const DB = 'typedcode-spike-proof';
const RUNNER_ORIGIN = process.env.SPIKE_RUNNER_ORIGIN as string;

/** Pyodide に要る最小の許可 (候補)。'unsafe-inline' は runner の inline script のため */
const CSP_STRICT = `default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob: ${PYODIDE}; worker-src blob:; connect-src ${PYODIDE}`;
const CSP_EVAL = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: ${PYODIDE}; worker-src blob:; connect-src ${PYODIDE}`;

type Opts = {
  sandbox?: string | null;
  allow?: string;
  csp?: string;
  url?: string;
  origin?: string;
  workerType?: 'module' | 'classic';
};

const WT = (process.env.SPIKE_WORKER_TYPE ?? 'classic') as 'module' | 'classic';

function report(name: string, value: unknown): void {
  console.log(`[spike] ${test.info().project.name} | ${name} | ${JSON.stringify(value)}`);
}

async function setup(page: Page): Promise<void> {
  await page.goto('');
  await page.addScriptTag({ content: src('harness.js') });
  await page.evaluate((s) => (window as any).__spike.configure(s), {
    probe: src('probe.js'),
    runner: src('runner.js'),
    worker: src('worker.js'),
  });
  await page.evaluate((db) => (window as any).__spike.seedParentDb(db), DB);
}

const create = (page: Page, opts: Opts) => page.evaluate((o) => (window as any).__spike.create(o), opts);
const call = (page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).__spike[f as string](...(a as unknown[])), [fn, args] as const);

async function pythonRunner(page: Page, opts: Opts): Promise<string> {
  const id = await create(page, opts);
  const init = await call(page, 'init', id, PYODIDE);
  report(`init ${JSON.stringify(opts)}`, init);
  expect(init.type, JSON.stringify(init)).toBe('py-ready');
  return id;
}

async function runPython(page: Page, id: string, code: string, stdin: string[] = [], eof = false) {
  await call(page, 'run', id, code);
  for (const line of stdin) {
    await call(page, 'waitFor', id, 'stdin-request', 30_000);
    await call(page, 'stdin', id, line);
  }
  if (eof) await call(page, 'eof', id);
  await call(page, 'waitFor', id, 'done', 60_000);
  return await call(page, 'output', id);
}

test.beforeEach(async ({ page, browser }) => {
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[console.error] ${m.text()}`);
  });
  await setup(page);
  report('browser', browser.version());
  report('parent', await page.evaluate(() => ({ origin: self.origin, coi: self.crossOriginIsolated })));
});

test('1. probe: sandbox iframe + Worker の隔離', async ({ page }) => {
  report('parent dbs', await call(page, 'parentDbNames'));
  for (const workerType of ['module', 'classic'] as const) {
    for (const opts of [
      { sandbox: 'allow-scripts', workerType },
      { sandbox: 'allow-scripts', allow: 'cross-origin-isolated', workerType },
    ] as Opts[]) {
      const id = await create(page, opts);
      const probe = await call(page, 'probe', id, DB).catch((e: Error) => ({ error: e.message, log: null }));
      report(`probe ${JSON.stringify(opts)}`, probe);
      report(`probe log ${JSON.stringify(opts)}`, await call(page, 'log', id));
      await call(page, 'destroy', id);
    }
  }
  expect(await call(page, 'readParentDb', DB)).toEqual([{ id: 1, payload: 'original' }]);
});

test('3a. 親の SAB を opaque origin の runner へ渡せるか', async ({ page }) => {
  for (const opts of [
    { sandbox: 'allow-scripts', workerType: WT },
    { sandbox: 'allow-scripts', allow: 'cross-origin-isolated', workerType: WT },
  ] as Opts[]) {
    const id = await create(page, opts);
    report(`parent SAB ${JSON.stringify(opts)}`, await call(page, 'sendParentSab', id));
    await call(page, 'destroy', id);
  }
});

test('2. Pyodide の読み込みと CSP', async ({ page }) => {
  for (const csp of [CSP_STRICT, CSP_EVAL]) {
    const id = await create(page, { sandbox: 'allow-scripts', allow: 'cross-origin-isolated', csp, workerType: WT });
    const init = await call(page, 'init', id, PYODIDE);
    report(`init csp=${csp === CSP_STRICT ? 'strict' : 'eval'}`, init);
    await call(page, 'destroy', id);
  }
});

test('2b/3b. Python: 隔離の負の対照と input() (日本語・複数行・EOF)', async ({ page }) => {
  const id = await pythonRunner(page, {
    sandbox: 'allow-scripts',
    allow: 'cross-origin-isolated',
    csp: CSP_STRICT,
    workerType: WT,
  });

  // 負の対照: Python から IndexedDB・親・ネットワークに届かない
  const neg = await runPython(
    page,
    id,
    [
      'import js',
      'from pyodide.ffi import to_js',
      'try:',
      `    r = js.indexedDB.open("${DB}")`,
      '    print("idb-open-returned", r)',
      'except Exception as e:',
      '    print("idb-open-error", type(e).__name__, e)',
      'try:',
      '    print("origin", js.self.origin, "coi", js.self.crossOriginIsolated)',
      'except Exception as e:',
      '    print("origin-error", e)',
      'try:',
      '    await js.fetch("https://example.com/")',
      '    print("fetch-ok")',
      'except Exception as e:',
      '    print("fetch-error", type(e).__name__, e)',
      'print("has-parent", hasattr(js, "parent"), "has-document", hasattr(js, "document"))',
      '# 結果の偽装: Worker の postMessage (runner は聞かない) と、global の port を eval で掴む',
      'js.postMessage(to_js({"type": "done", "success": True}, dict_converter=js.Object.fromEntries))',
      'print("worker-postMessage-sent")',
      'try:',
      `    js.eval("port.postMessage({type: 'stdout', text: 'FORGED'})")`,
      '    print("eval-ok")',
      'except Exception as e:',
      '    print("eval-error", type(e).__name__, e)',
      'try:',
      '    from pyodide.code import run_js',
      '    run_js("1+1")',
      '    print("run_js-ok")',
      'except Exception as e:',
      '    print("run_js-error", type(e).__name__, e)',
    ].join('\n')
  );
  report('python negative controls', neg);
  report('rejected messages so far', await call(page, 'rejected', id));
  expect(neg.stdout).not.toContain('FORGED');
  expect(neg.stdout).toContain('idb-open-error');

  // 正の対照: print / input (日本語) / 複数行 / sys.stdin / EOF
  const pos = await runPython(
    page,
    id,
    [
      'import sys',
      'name = input("名前: ")',
      'print("こんにちは", name)',
      'a = input()',
      'b = input()',
      'print("sum", int(a) + int(b))',
      'rest = sys.stdin.read()',
      'print("rest", repr(rest))',
      'try:',
      '    input()',
      'except EOFError:',
      '    print("EOF ok")',
    ].join('\n'),
    ['山田 太郎\n', '1\n', '2\n', '残り1\n残り2\n'],
    true
  );
  report('python stdin', pos);
  expect(pos.stdout).toContain('こんにちは 山田 太郎');
  expect(pos.stdout).toContain('sum 3');
  expect(pos.stdout).toContain("rest '残り1\\n残り2\\n'");
  expect(pos.done?.success).toBe(true);
  expect(await call(page, 'readParentDb', DB)).toEqual([{ id: 1, payload: 'original' }]);
});

test('4. 無限ループ中の親の応答・停止・即再実行・入力待ちの停止', async ({ page }) => {
  const opts: Opts = { sandbox: 'allow-scripts', allow: 'cross-origin-isolated', csp: CSP_STRICT, workerType: WT };
  const id = await pythonRunner(page, opts);
  report('baseline responsiveness', await call(page, 'responsiveness', 1000, DB));
  await call(page, 'run', id, 'while True:\n    pass\n');
  await page.waitForTimeout(500);
  report('responsiveness during python infinite loop', await call(page, 'responsiveness', 2000, DB));
  const t0 = Date.now();
  await call(page, 'destroy', id);
  report('destroy ms', Date.now() - t0);

  // 即再実行 (新しい iframe。HTTP キャッシュが効くか)
  const id2 = await pythonRunner(page, opts);
  const out = await runPython(page, id2, 'print(sum(range(10)))');
  report('rerun', out);
  expect(out.stdout).toBe('45\n');

  // 入力待ちのまま停止
  await call(page, 'run', id2, 'input()');
  await call(page, 'waitFor', id2, 'stdin-request', 30_000);
  await call(page, 'destroy', id2);
  const id3 = await pythonRunner(page, opts);
  const out3 = await runPython(page, id3, 'print("after stdin stop")');
  expect(out3.stdout).toBe('after stdin stop\n');
  report('rows after loop', await call(page, 'readParentDb', DB));

  // 大量出力 (1 回の write ごとに postMessage が 2 段) の間の親の応答
  await call(page, 'run', id3, 'for i in range(200000):\n    print(i)\n');
  const during = await call(page, 'responsiveness', 1500, DB);
  await call(page, 'waitFor', id3, 'done', 120_000);
  const big = await call(page, 'output', id3);
  report('responsiveness during large output', { ...during, stdoutChars: big.stdout.length });

  // runner の初期化失敗 (取得元が無い)
  const bad = await create(page, opts);
  report('init failure', await call(page, 'init', bad, 'https://cdn.jsdelivr.net/pyodide/v0.0.0-missing/full/'));
});

test('2c. micropip (PyPI) と CSP の connect-src', async ({ page }) => {
  const pypi = CSP_STRICT.replace(
    `connect-src ${PYODIDE}`,
    `connect-src ${PYODIDE} https://pypi.org https://files.pythonhosted.org`
  );
  for (const [label, csp] of [
    ['strict', CSP_STRICT],
    ['strict+pypi', pypi],
  ] as const) {
    const id = await pythonRunner(page, {
      sandbox: 'allow-scripts',
      allow: 'cross-origin-isolated',
      csp,
      workerType: WT,
    });
    const out = await runPython(
      page,
      id,
      [
        'import pyodide_js',
        'await pyodide_js.loadPackage("micropip")',
        'import micropip',
        'try:',
        '    await micropip.install("snowballstemmer")',
        '    import snowballstemmer',
        '    print("micropip-ok")',
        'except Exception as e:',
        '    print("micropip-error", type(e).__name__, str(e)[:200])',
      ].join('\n')
    );
    report(`micropip csp=${label}`, out);
    await call(page, 'destroy', id);
  }
});

test('6. runner が親と別プロセス (OOPIF) か', async ({ page, browser }) => {
  // OOPIF は CDP の Target.getTargets に type: 'iframe' で現れる (同じプロセスの iframe は現れない)
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send('Target.setDiscoverTargets', { discover: true, filter: [{}] });
  const iframeTargets = async () =>
    ((await cdp.send('Target.getTargets', { filter: [{}] })).targetInfos as { type: string; url: string }[])
      .filter((t) => t.type !== 'browser')
      .map((t) => `${t.type} ${t.url.slice(0, 60)}`);
  const variants: [string, Opts][] = [
    ['opaque srcdoc + coi', { sandbox: 'allow-scripts', allow: 'cross-origin-isolated', workerType: WT }],
    ['opaque srcdoc', { sandbox: 'allow-scripts', workerType: WT }],
  ];
  if (test.info().project.name === 'static-prod-headers') {
    const url = `${RUNNER_ORIGIN}/runner.html`;
    variants.push([
      'cross-site url + coi',
      { sandbox: null, allow: 'cross-origin-isolated', url, origin: RUNNER_ORIGIN, workerType: WT },
    ]);
  }
  for (const [label, opts] of variants) {
    const id = await create(page, opts);
    report(`oopif ${label}`, await iframeTargets());
    await call(page, 'destroy', id);
  }
});

test('5. 別 origin の runner (別ポート / 別サイト)', async ({ page }) => {
  test.skip(test.info().project.name !== 'static-prod-headers', 'static サーバだけが runner のポートを持つ');
  const url = `${RUNNER_ORIGIN}/runner.html`;
  for (const opts of [
    { sandbox: null, allow: 'cross-origin-isolated', url, origin: RUNNER_ORIGIN, workerType: WT },
    { sandbox: null, url, origin: RUNNER_ORIGIN, workerType: WT },
  ] as Opts[]) {
    const id = await create(page, opts).catch((e: Error) => `create failed: ${e.message}`);
    if (id.startsWith('create failed')) {
      report(`cross-origin create ${JSON.stringify(opts)}`, id);
      continue;
    }
    report(`cross-origin probe ${JSON.stringify(opts)}`, await call(page, 'probe', id, DB));
    report(`cross-origin parent SAB ${JSON.stringify(opts)}`, await call(page, 'sendParentSab', id));
    await call(page, 'destroy', id);
  }
});
