import { test, expect, type Page } from '@playwright/test';
import { CASUAL_SESSION_DB, EditorApp } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * Python の実行コードを、記録 (proof の IndexedDB) と同じ origin から隔離する (#719 / #650)。
 *
 * Python は opaque origin の sandbox iframe (`iframe[data-python-runner]`) の中の Worker で Pyodide を動かす。
 * ここで確かめること:
 * - (a) 実行コードから proof の IndexedDB を列挙・open できず、実行の前後で保存済みのイベントが変わらず、
 *   export が verify-cli (fast) を通る。`js.eval` / 任意の fetch / 偽の postMessage も届かない
 * - (b) stdout / stderr / 複数行の input と sys.stdin が、隔離した runner でもターミナルの経路で動く
 *   (input の案内文・日本語・停止 → 再実行は code-execution-c-python.spec.ts、EOF は author-verification.spec.ts)
 * - (c) 無限ループ・runner の初期化失敗・大量出力でも、エディタの記録と export が止まらない
 *
 * Pyodide を jsDelivr から取るテストは `@nightly` (code-execution-c-python.spec.ts と同じ扱い)。
 * 取得元を塞いだ初期化失敗のテストは外部に依存しないので PR ゲートで走る。
 * 実行の状態はターミナルの状態契約 (`data-exec-state` / `data-exec-run` / `data-exec-outcome`) で読む。
 */

const TERMINAL = '#xterm-container';
/** Pyodide の取得と初期化を含む 1 回目の実行の終わりを待つ上限 */
const FIRST_RUN_TIMEOUT_MS = 240_000;
/** Pyodide の取得元 (pythonRunnerProtocol.ts の PYODIDE_CDN_URL と同じ配信元) */
const PYODIDE_ROUTE = 'https://cdn.jsdelivr.net/pyodide/**';

test.describe.configure({ timeout: 360_000 });

async function replaceCode(app: EditorApp, code: string): Promise<void> {
  await app.focusEditor();
  await app.page.keyboard.press('Control+A');
  await app.page.keyboard.press('Delete');
  await app.injectCodeBlock(code);
}

async function execState(page: Page) {
  return page.locator(TERMINAL).evaluate((el) => ({
    state: el.getAttribute('data-exec-state'),
    run: Number(el.getAttribute('data-exec-run') ?? '0'),
    outcome: el.getAttribute('data-exec-outcome'),
  }));
}

async function startRun(page: Page): Promise<number> {
  const run = (await execState(page)).run + 1;
  await page.locator('#run-code-btn').click();
  await expect(page.locator(TERMINAL)).toHaveAttribute('data-exec-run', String(run), { timeout: 15_000 });
  return run;
}

async function waitOutcome(page: Page, run: number, timeout: number): Promise<string | null> {
  await expect
    .poll(
      async () => {
        const s = await execState(page);
        return s.run === run && s.state === 'idle';
      },
      { timeout, intervals: [500, 1_000, 2_000] }
    )
    .toBe(true);
  return (await execState(page)).outcome;
}

async function runAndWait(page: Page, timeout = FIRST_RUN_TIMEOUT_MS): Promise<string | null> {
  return waitOutcome(page, await startRun(page), timeout);
}

async function terminalText(page: Page): Promise<string> {
  return page
    .locator(`${TERMINAL} .xterm-rows`)
    .evaluate((el) => Array.from(el.children, (row) => (row.textContent ?? '').replace(/ /g, ' ')).join('\n'));
}

const terminalLines = async (page: Page) => (await terminalText(page)).split('\n').map((l) => l.trim());

async function typeLine(page: Page, line: string): Promise<void> {
  await page.locator(TERMINAL).click();
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}

/** エディタ (親) から、casual の session DB の events を id 順に JSON で読む */
function storedEvents(page: Page): Promise<string[]> {
  return page.evaluate(
    (dbName) =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open(dbName);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const req = db.transaction(['events'], 'readonly').objectStore('events').getAll();
          req.onsuccess = () => {
            db.close();
            const rows = req.result as Array<{ id: number }>;
            resolve(rows.sort((a, b) => a.id - b.id).map((r) => JSON.stringify(r)));
          };
          req.onerror = () => reject(req.error);
        };
      }),
    CASUAL_SESSION_DB
  );
}

async function expectExportPasses(app: EditorApp): Promise<void> {
  await app.waitForSynced();
  const zipPath = await app.exportAllTabs();
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
}

/**
 * 実行コードから届いてはいけないものを試し、結果を `TC719 <結果>` の行で出す。
 * 修正前 (同じ origin の Worker) では IndexedDB を readwrite で開け、jsDelivr の任意のファイルを取れ、
 * Worker の postMessage で偽の done を送ると run がその内容で終わっていた
 */
const PROBE_CODE = [
  'import js, asyncio',
  'from pyodide.ffi import create_proxy, to_js',
  `DB = "${CASUAL_SESSION_DB}"`,
  'def mark(s):',
  '    print("TC719 " + s)',
  'def why(e):',
  '    return "SecurityError" if "SecurityError" in str(e) else type(e).__name__',
  'try:',
  '    names = await js.indexedDB.databases()',
  '    mark("list-ok " + ",".join(d.name for d in names))',
  'except Exception as e:',
  '    mark("list-blocked " + why(e))',
  'async def try_open():',
  '    fut = asyncio.get_event_loop().create_future()',
  '    try:',
  '        req = js.indexedDB.open(DB)',
  '    except Exception as e:',
  '        return "open-blocked " + why(e)',
  '    def ok(ev):',
  '        try:',
  '            tx = req.result.transaction(to_js(["events"]), "readwrite")',
  '            c = tx.objectStore("events").count()',
  '            c.onsuccess = create_proxy(lambda _e: fut.set_result("open-ok readwrite count=" + str(c.result)))',
  '        except Exception as e2:',
  '            fut.set_result("open-ok tx-error " + type(e2).__name__)',
  '    req.onsuccess = create_proxy(ok)',
  '    req.onerror = create_proxy(lambda _e: fut.set_result("open-error"))',
  '    return await fut',
  'mark(await try_open())',
  'try:',
  '    js.eval("1 + 1")',
  '    mark("eval-ok")',
  'except Exception as e:',
  '    mark("eval-blocked")',
  'try:',
  '    r = await js.fetch("https://cdn.jsdelivr.net/npm/left-pad@1.3.0/package.json")',
  '    mark("fetch-ok " + str(r.status))',
  'except Exception as e:',
  '    mark("fetch-blocked")',
  'mark("document " + str(hasattr(js, "document")))',
  'for run_id in range(1, 4):',
  '    js.postMessage(to_js({"type": "done", "runId": run_id, "success": False, "error": "forged", "result": None}, dict_converter=js.Object.fromEntries))',
  'mark("end")',
  '',
].join('\n');

test('python: @nightly 実行コードから proof の IndexedDB に届かず、記録は変わらず、export が verify-cli を通る (#719)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('python');
  // 実際の打鍵で proof を作ってから、隔離を試すコードに入れ替える
  await app.typeCode('# typed by a human\n');
  await replaceCode(app, PROBE_CODE);
  await app.waitForSynced();
  const before = await storedEvents(page);
  expect(before.length).toBeGreaterThan(1);

  const outcome = await runAndWait(page);
  const text = await terminalText(page);
  expect(outcome, `terminal:\n${text}`).toBe('success');
  const marks = (await terminalLines(page)).filter((l) => l.startsWith('TC719 '));
  expect(marks).toEqual([
    'TC719 list-blocked SecurityError',
    'TC719 open-blocked SecurityError',
    'TC719 eval-blocked',
    'TC719 fetch-blocked',
    'TC719 document False',
    'TC719 end',
  ]);

  // 実行の前に保存されていたイベントは、実行の後もそのまま (実行の記録は後ろに足されるだけ)
  await app.waitForSynced();
  const after = await storedEvents(page);
  expect(after.slice(0, before.length)).toEqual(before);
  await expectExportPasses(app);
});

test('python: @nightly 隔離した runner でも stdout / stderr / 複数行の input / sys.stdin / 空の行の Ctrl+D の EOF が動く', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('python');
  await replaceCode(
    app,
    [
      'import sys',
      'a = input("a? ")',
      'b = sys.stdin.readline()',
      'print("got", a, b.strip())',
      'print("err-line", file=sys.stderr)',
      'rest = sys.stdin.read()',
      'print("rest", repr(rest))',
      '',
    ].join('\n')
  );

  const run = await startRun(page);
  await expect(page.locator(TERMINAL)).toHaveAttribute('data-stdin-state', 'open', { timeout: FIRST_RUN_TIMEOUT_MS });
  await typeLine(page, 'いち');
  await typeLine(page, 'two');
  await typeLine(page, 'three');
  await page.keyboard.press('Control+D');

  const outcome = await waitOutcome(page, run, 60_000);
  expect(outcome, `terminal:\n${await terminalText(page)}`).toBe('success');
  await expect
    .poll(() => terminalLines(page))
    .toEqual(expect.arrayContaining(['a? いち', 'got いち two', 'err-line', "rest 'three\\n'"]));
});

test('python: @nightly 無限ループの間も打鍵が記録され、停止すると aborted で終わり、export が verify-cli を通る', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('python');
  await replaceCode(app, 'while True:\n    pass\n');

  const run = await startRun(page);
  await expect(page.locator(TERMINAL)).toHaveAttribute('data-stdin-state', 'open', { timeout: FIRST_RUN_TIMEOUT_MS });
  // ループの間もエディタは応答し、打鍵が記録される
  const before = await app.eventCount();
  await app.typeCode('# typing while looping\n');
  await expect.poll(() => app.eventCount()).toBeGreaterThan(before);
  await expect(page.locator(TERMINAL)).toHaveAttribute('data-exec-state', 'running');

  await page.locator('#stop-code-btn').click();
  expect(await waitOutcome(page, run, 15_000)).toBe('aborted');
  await expect(page.locator('iframe[data-python-runner]')).toHaveCount(0);
  await expectExportPasses(app);
});

test('python: @nightly 出力が予算を超えると打ち切って error で終わり、次の実行は runner を作り直して動く', async ({
  page,
}) => {
  // dev 限定の上書きで出力の予算を縮める (limits.ts の __tcExecLimits)
  await page.addInitScript(() => {
    (window as unknown as { __tcExecLimits?: unknown }).__tcExecLimits = { outputBudgetChars: 5_000 };
  });
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('python');
  await replaceCode(app, 'for i in range(1000000):\n    print(i)\n');

  expect(await runAndWait(page)).toBe('error');
  await expect.poll(() => terminalText(page)).toContain('Output limit exceeded (5000 characters)');
  await expect(page.locator('iframe[data-python-runner]')).toHaveCount(0);

  await replaceCode(app, 'print("after-limit-" + str(6 * 7))\n');
  expect(await runAndWait(page)).toBe('success');
  await expect.poll(() => terminalText(page)).toContain('after-limit-42');
  await expectExportPasses(app);
});

test('python: Pyodide を取得できないと runner の初期化が error で終わり、エディタの記録と export は止まらない', async ({
  page,
}) => {
  // Pyodide の取得を止めておき、その間に runner の iframe の属性を確かめてから失敗させる (外部に依存しない)
  let releaseRoute!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseRoute = resolve;
  });
  let requested = false;
  await page.context().route(PYODIDE_ROUTE, async (route) => {
    requested = true;
    await held;
    await route.abort();
  });

  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('python');
  await replaceCode(app, 'print("never")\n');

  const run = await startRun(page);
  const runner = page.locator('iframe[data-python-runner]');
  await expect(runner).toHaveCount(1);
  await expect(runner).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(runner).toHaveAttribute('allow', 'cross-origin-isolated');
  // runner が cross-origin isolated で動き始め、Worker が Pyodide を取りに来た (fail closed の手前まで進んだ)
  await expect.poll(() => requested, { timeout: 30_000 }).toBe(true);
  releaseRoute();

  expect(await waitOutcome(page, run, 60_000)).toBe('error');
  await expect(runner).toHaveCount(0);
  expect(await terminalText(page)).not.toContain('never');

  const before = await app.eventCount();
  await app.typeCode('# still recording\n');
  await expect.poll(() => app.eventCount()).toBeGreaterThan(before);
  await expectExportPasses(app);
});
