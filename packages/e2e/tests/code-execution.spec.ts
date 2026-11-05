import { test, expect, type Page } from '@playwright/test';
import {
  BOOT_TIMEOUT_MS,
  EditorApp,
  installTermsAccepted,
  listZipEntries,
  readAllProofEvents,
  readZipEntryText,
} from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * JS / TS のコード実行の隔離と停止の回帰テスト (#290 / ADR-0041)。
 *
 * ユーザーの JS (TS は transpile 後) は opaque origin の sandbox iframe の中の Worker で動く。
 * ここでは実ブラウザで次を確かめる:
 * - 停止・タイムアウト・出力予算の超過で実行環境ごと終わり、その後に出力・副作用が出ない
 * - 停止ボタンは実行中だけ見え、実行が終わると隠れる (#620)
 * - 同期の無限ループ中もエディタが応答して記録が進み、停止できる
 * - 実行コードから親 DOM・IndexedDB・localStorage・ネットワーク・`/author` の秘密鍵に届かない
 * - 停止 → 即再実行で古い run が新しい run を壊さない
 * - 結果 (outcome) が区別されて記録され、異常の後も編集が export されて verify-cli (fast) が通る
 * - TS は Monaco 同梱の TypeScript worker で transpile され (#605)、型注釈と top-level await を含むコードが
 *   エディタと `/author` で動き、構文エラーは `(行,列): error TS…` とマーカーで知らされる
 *
 * 実行の状態は状態契約 (ターミナルのコンテナの `data-exec-state` / `data-exec-run` /
 * `data-exec-outcome`。packages/editor/AGENTS.md「状態契約」) で読み、翻訳テキストに依存しない。
 * ターミナルの中身はユーザーコードが出した文字列と executor の英語固定の行だけを読む。
 * タイムアウトと出力予算は dev 限定フック `window.__tcExecLimits` で縮める。
 */

const TERMINAL = '#xterm-container';

/** テストの手順そのものが固まったら (= エディタのメインスレッドが止まったら) 失敗にする外側の watchdog */
async function withWatchdog<T>(label: string, ms: number, action: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`watchdog: "${label}" did not finish within ${ms}ms (page hung?)`)), ms);
  });
  try {
    return await Promise.race([action(), watchdog]);
  } finally {
    clearTimeout(timer);
  }
}

/** アクティブなタブの中身を code に置き換える (Monaco の自動補完を通らない 1 回の編集で入れる) */
async function replaceCode(app: EditorApp, code: string): Promise<void> {
  await app.focusEditor();
  await app.page.keyboard.press('Control+A');
  await app.page.keyboard.press('Delete');
  await app.injectCodeBlock(code);
}

/** 実行の状態契約を読む */
async function execState(page: Page, terminal = TERMINAL) {
  return page.locator(terminal).evaluate((el) => ({
    state: el.getAttribute('data-exec-state'),
    run: Number(el.getAttribute('data-exec-run') ?? '0'),
    outcome: el.getAttribute('data-exec-outcome'),
  }));
}

/** Run を押し、新しい run が始まった (data-exec-run が進んだ) ことを待って、その番号を返す */
async function startRun(page: Page, runButton = '#run-code-btn', terminal = TERMINAL): Promise<number> {
  const before = (await execState(page, terminal)).run;
  await page.locator(runButton).click();
  // expect.poll は間隔が伸びるので、停止を急ぐテスト (500ms 後の副作用) に間に合うよう属性の待ちで見る
  await expect(page.locator(terminal)).toHaveAttribute('data-exec-run', String(before + 1), { timeout: 15_000 });
  return before + 1;
}

/** run が終わる (data-exec-state=idle) のを待って outcome を返す */
async function waitOutcome(page: Page, run: number, terminal = TERMINAL, timeout = 30_000): Promise<string | null> {
  await expect
    .poll(
      async () => {
        const s = await execState(page, terminal);
        return s.run === run && s.state === 'idle';
      },
      { timeout }
    )
    .toBe(true);
  return (await execState(page, terminal)).outcome;
}

async function stopRun(page: Page): Promise<void> {
  await page.locator('#stop-code-btn').click();
}

/**
 * ターミナルの見えている行の文字列 (xterm の DOM レンダラの行)。xterm は書き込みを次のフレームで
 * 描くので、含まれることを確かめるときは expect.poll で待つ
 */
async function terminalText(page: Page, terminal = TERMINAL): Promise<string> {
  return page
    .locator(`${terminal} .xterm-rows`)
    .evaluate((el) => Array.from(el.children, (row) => (row.textContent ?? '').replace(/\u00a0/g, ' ')).join('\n'));
}

async function setExecLimits(page: Page, limits: { timeoutMs?: number; outputBudgetChars?: number }): Promise<void> {
  await page.evaluate((l) => {
    (window as unknown as { __tcExecLimits?: unknown }).__tcExecLimits = l;
  }, limits);
}

async function openJsTab(page: Page, language: 'javascript' | 'typescript' = 'javascript'): Promise<EditorApp> {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage(language);
  return app;
}

/** 実行が残っていない (sandbox の iframe が片付いた) */
async function expectNoRunnerFrame(page: Page): Promise<void> {
  await expect(page.locator('iframe[data-code-runner]')).toHaveCount(0);
}

// 停止は、続きを待ち始めた (WAITING が出た) のを見てから押す。TS も変換を終えて sandbox で
// 続きを待っている所で止まる。続きは停止のクリックが CI の遅いランナーでも先に届くよう 5 秒後にする
// (1.5 秒では、クリックが続きの終わりより遅れて run が自分で終わり failure になった = #585)。
// 停止の後は、続きの時刻を 1 秒過ぎるまで待って、続きが出ないことを確かめる
const LATE_DELAY_MS = 5_000;
const LATE_SIDE_EFFECT = [
  'console.log("WAITING");',
  `await new Promise((r) => setTimeout(r, ${LATE_DELAY_MS}));`,
  'console.log("LATE");',
  'localStorage.setItem("pwned", "1");',
  '',
].join('\n');

for (const language of ['javascript', 'typescript'] as const) {
  test(`${language}: 停止した後に非同期の続きが出力も副作用も出さず、aborted が記録される`, async ({ page }) => {
    const app = await openJsTab(page, language);
    await replaceCode(app, LATE_SIDE_EFFECT);

    const run = await startRun(page);
    await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain('WAITING');
    const waitingSeenAt = Date.now();
    await stopRun(page);
    // 落ちたときに、続きが走ってしまった (LATE が出た) のかを読めるようにターミナルを添える
    const outcome = await waitOutcome(page, run);
    expect(outcome, `terminal:\n${await terminalText(page)}`).toBe('aborted');

    await page.waitForTimeout(Math.max(0, waitingSeenAt + LATE_DELAY_MS + 1_000 - Date.now()));
    expect(await terminalText(page)).not.toContain('LATE');
    expect(await page.evaluate(() => localStorage.getItem('pwned'))).toBeNull();
    await expectNoRunnerFrame(page);

    // proof の result イベントにも aborted が載る
    await app.waitForSynced();
    const zipPath = await app.exportCurrentTab();
    const events = [...(await readAllProofEvents(zipPath)).values()][0] ?? [];
    const outcomes = events
      .filter((e) => e.type === 'codeExecution' && (e.data as { phase?: string } | null)?.phase === 'result')
      .map((e) => (e.data as { outcome?: string }).outcome);
    expect(outcomes).toEqual(['aborted']);
  });
}

test('停止ボタンは実行中だけ表示され、success・aborted・failure・timeout のどれで終わっても隠れる (#620)', async ({
  page,
}) => {
  const app = await openJsTab(page);
  const stopButton = page.locator('#stop-code-btn');
  // 実行していないときは表示されない (`hidden` が付いていても隠す CSS が無く、見えて押せていた = #620)
  await expect(stopButton).toBeHidden();
  await expect(stopButton).toHaveCSS('display', 'none');

  // success: 続きを待つ間に表示を確かめてから、自分で終わるのを待つ
  await replaceCode(app, 'await new Promise((r) => setTimeout(r, 3000));\nconsole.log("done");\n');
  const ok = await startRun(page);
  await expect(stopButton).toBeVisible();
  expect(await waitOutcome(page, ok)).toBe('success');
  await expect(stopButton).toBeHidden();

  await replaceCode(app, 'for (;;) {}\n');
  const stopped = await startRun(page);
  await expect(stopButton).toBeVisible();
  await stopRun(page);
  expect(await waitOutcome(page, stopped)).toBe('aborted');
  await expect(stopButton).toBeHidden();

  await replaceCode(app, 'null.x;\n');
  const failed = await startRun(page);
  expect(await waitOutcome(page, failed)).toBe('failure');
  await expect(stopButton).toBeHidden();

  await setExecLimits(page, { timeoutMs: 3_000 });
  await replaceCode(app, 'setInterval(() => {}, 100);\n');
  const timedOut = await startRun(page);
  await expect(stopButton).toBeVisible();
  expect(await waitOutcome(page, timedOut)).toBe('timeout');
  await expect(stopButton).toBeHidden();
});

test('同期の無限ループ中もエディタが応答して記録が進み、停止して再実行できる', async ({ page }) => {
  const app = await openJsTab(page);
  await replaceCode(app, 'for (;;) {}\n');

  const run = await withWatchdog('start the loop', 15_000, () => startRun(page));
  await page.waitForTimeout(1_000);

  const before = await app.eventCount();
  await withWatchdog('type while the loop runs', 10_000, () => app.typeCode('// typing'));
  await withWatchdog('event count grows while the loop runs', 15_000, () =>
    expect.poll(() => app.eventCount(), { timeout: 10_000 }).toBeGreaterThan(before)
  );
  expect((await execState(page)).state).toBe('running');

  await withWatchdog('stop the loop', 10_000, () => stopRun(page));
  expect(await waitOutcome(page, run)).toBe('aborted');
  await expectNoRunnerFrame(page);

  await replaceCode(app, 'console.log("again");\n');
  const second = await withWatchdog('run again', 15_000, () => startRun(page));
  expect(await waitOutcome(page, second)).toBe('success');
  await expect.poll(() => terminalText(page)).toContain('again');
});

test('実行コードから親 DOM・IndexedDB・localStorage・ネットワークに届かない', async ({ page, baseURL }) => {
  const app = await openJsTab(page);
  const origin = new URL(baseURL ?? page.url()).origin;
  await replaceCode(
    app,
    [
      'const out = [];',
      'const probe = async (name, fn) => {',
      '  try { await fn(); out.push(name + ":open"); } catch (e) { out.push(name + ":blocked"); }',
      '};',
      'await probe("dom", () => { parent.document.title = "pwned-by-run"; });',
      'await probe("idb", () => new Promise((res, rej) => {',
      '  const r = indexedDB.open("tc-run-pwned");',
      '  r.onsuccess = () => res(r.result);',
      '  r.onerror = () => rej(r.error);',
      '}));',
      'await probe("ls", () => localStorage.setItem("pwned", "1"));',
      `await probe("fetch", () => fetch(${JSON.stringify(`${origin}/`)}));`,
      'console.error(out.join(" "));',
      '',
    ].join('\n')
  );

  const run = await startRun(page);
  expect(await waitOutcome(page, run)).toBe('success');
  await expect.poll(() => terminalText(page)).toContain('[ERROR] dom:blocked idb:blocked ls:blocked fetch:blocked');

  expect(await page.title()).not.toBe('pwned-by-run');
  expect(await page.evaluate(() => localStorage.getItem('pwned'))).toBeNull();
  const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
  expect(dbs).not.toContain('tc-run-pwned');
  // 隔離しても親は cross-origin isolated のまま (C の Wasmer の SharedArrayBuffer を壊さない)
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
});

test('停止してすぐ再実行しても古い run の出力が混ざらず、新しい run を停止できる', async ({ page }) => {
  const app = await openJsTab(page);
  await replaceCode(
    app,
    [
      'const id = Math.random().toString(36).slice(2, 8);',
      'setInterval(() => console.log("tick " + id), 50);',
      '',
    ].join('\n')
  );

  const first = await startRun(page);
  await expect.poll(() => terminalText(page)).toContain('tick ');
  await stopRun(page);
  const second = await startRun(page);
  expect(second).toBe(first + 1);

  await page.waitForTimeout(600);
  const ids = new Set([...(await terminalText(page)).matchAll(/tick (\w{6})/g)].map((m) => m[1]));
  expect(ids.size, `ticks from more than one run: ${[...ids].join(', ')}`).toBe(1);

  // 新しい run は今も停止できる
  expect((await execState(page)).state).toBe('running');
  await stopRun(page);
  expect(await waitOutcome(page, second)).toBe('aborted');
  // xterm は次のフレームで描くので、停止の行が出るまで待ってから比べる
  await expect.poll(() => terminalText(page)).toContain('execution aborted');
  const settled = await terminalText(page);
  await page.waitForTimeout(400);
  expect(await terminalText(page)).toBe(settled);
  await expectNoRunnerFrame(page);
});

test('タイムアウト・正常終了・実行時エラーが区別され、エラーのマーカーが投げた行に付く', async ({ page }) => {
  const app = await openJsTab(page);
  await setExecLimits(page, { timeoutMs: 1_500 });

  await replaceCode(app, 'setInterval(() => {}, 100);\n');
  const timedOut = await startRun(page);
  expect(await waitOutcome(page, timedOut)).toBe('timeout');
  await expect.poll(() => terminalText(page)).toContain('execution timed out');
  await expectNoRunnerFrame(page);

  await replaceCode(app, 'setTimeout(() => console.log("done later"), 200);\nconsole.log("ok");\n');
  const ok = await startRun(page);
  expect(await waitOutcome(page, ok)).toBe('success');
  await expect.poll(() => terminalText(page)).toContain('done later');

  await replaceCode(app, 'const a = 1;\nnull.x;\n');
  const failed = await startRun(page);
  expect(await waitOutcome(page, failed)).toBe('failure');
  await expect.poll(() => terminalText(page)).toContain('(at line 2, column 6)');

  // マーカー (squiggly) が `null.x;` の行に付いている
  const squiggly = page.locator('.monaco-editor .squiggly-error').first();
  await expect(squiggly).toBeVisible();
  const markerTop = (await squiggly.boundingBox())?.y ?? -1;
  const lineTexts = await page
    .locator('.monaco-editor .view-lines .view-line')
    .evaluateAll((lines) => lines.map((l) => ({ top: l.getBoundingClientRect().top, text: l.textContent ?? '' })));
  const markedLine = lineTexts.find((l) => Math.abs(l.top - markerTop) < 4);
  expect(markedLine?.text.replace(/ /g, ' ')).toBe('null.x;');
});

test('typescript: 型注釈と top-level await を含むコードが transpile されて実行され、success が記録される', async ({
  page,
}) => {
  const app = await openJsTab(page, 'typescript');
  await replaceCode(
    app,
    'interface U { n: string }\nconst u: U = { n: "ok" };\nawait Promise.resolve();\nconsole.log(u.n);\n'
  );

  const run = await startRun(page);
  expect(await waitOutcome(page, run)).toBe('success');
  await expect.poll(() => terminalText(page)).toContain('ok');

  await app.waitForSynced();
  const zipPath = await app.exportCurrentTab();
  const events = [...(await readAllProofEvents(zipPath)).values()][0] ?? [];
  const outcomes = events
    .filter((e) => e.type === 'codeExecution' && (e.data as { phase?: string } | null)?.phase === 'result')
    .map((e) => (e.data as { outcome?: string }).outcome);
  expect(outcomes).toEqual(['success']);
});

test('typescript: C のタブから切り替えた直後に実行しても、TS の言語モードの読み込みを待って success になる (#624)', async ({
  page,
}) => {
  // 初めて TS の言語モードを読み込む間に変換が走ると、Monaco の getTypeScriptWorker() が登録前に
  // "TypeScript not registered!" で reject していた。JS / TS を経由すると読み込み済みになって再現しないので、
  // 既定の C のタブにコードを入れ、TS への切り替えと Run を同じタスクで行う
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await replaceCode(app, 'const n: number = 1;\nconsole.log("switched " + n);\n');

  await page.evaluate(() => {
    const selector = document.getElementById('language-selector') as HTMLSelectElement;
    selector.value = 'typescript';
    selector.dispatchEvent(new Event('change', { bubbles: true }));
    (document.getElementById('run-code-btn') as HTMLButtonElement).click();
  });
  await expect(page.locator(TERMINAL)).toHaveAttribute('data-exec-run', '1');
  const outcome = await waitOutcome(page, 1);
  expect(outcome, `terminal:\n${await terminalText(page)}`).toBe('success');
  await expect.poll(() => terminalText(page)).toContain('switched 1');
});

test('typescript: 構文エラーは実行せずに failure になり、位置付きのエラーとマーカーがその行に出る', async ({
  page,
}) => {
  const app = await openJsTab(page, 'typescript');
  await replaceCode(app, 'const x: = 1;\n');

  const run = await startRun(page);
  expect(await waitOutcome(page, run)).toBe('failure');
  await expect.poll(() => terminalText(page)).toMatch(/\(1,\d+\): error TS\d+:/);
  await expectNoRunnerFrame(page);

  // 実行のマーカー (squiggly) が `const x: = 1;` の行に、エラーの列から行末まで付いている。
  // Monaco 自身の構文検査も同じ位置に squiggly を出す (幅は誤りの字句 `=` だけ) ので、
  // 行末まで届くもの (= parseErrors → resolveMarkerRange が付けたもの) があることで見分ける
  await expect
    .poll(async () => {
      const squigglies = await page
        .locator('.monaco-editor .squiggly-error')
        .evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ top: r.top, right: r.right })));
      const lines = await page.locator('.monaco-editor .view-lines .view-line').evaluateAll((els) =>
        els.map((l) => ({
          top: l.getBoundingClientRect().top,
          textRight: (l.firstElementChild ?? l).getBoundingClientRect().right,
          text: (l.textContent ?? '').replace(/ /g, ' '),
        }))
      );
      const line = lines.find((l) => l.text === 'const x: = 1;');
      if (!line) return 'line not found';
      return squigglies.some((s) => Math.abs(s.top - line.top) < 4 && Math.abs(s.right - line.textRight) < 4)
        ? 'marked to end of line'
        : `no squiggly reaches the end of the line: ${JSON.stringify({ line, squigglies })}`;
    })
    .toBe('marked to end of line');
});

test('大量出力は予算で打ち切られて error になり、その間もエディタの記録が進む', async ({ page }) => {
  const app = await openJsTab(page);
  await setExecLimits(page, { outputBudgetChars: 200_000 });
  await replaceCode(app, 'for (;;) console.log("x".repeat(100));\n');

  const before = await app.eventCount();
  const run = await startRun(page);
  await withWatchdog('type while output floods', 10_000, () => app.typeCode('// flood'));
  expect(await waitOutcome(page, run)).toBe('error');
  await expect.poll(() => terminalText(page)).toContain('Output limit exceeded');
  await expect.poll(() => app.eventCount()).toBeGreaterThan(before);
  await expectNoRunnerFrame(page);
});

test('実行の異常 (非同期・同期の無限処理・大量出力・Worker の終了) の後も、実行前と実行中の編集が export されて検証が通る', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await setExecLimits(page, { timeoutMs: 2_000, outputBudgetChars: 100_000 });

  const scenarios = [
    { name: 'interval', code: 'setInterval(() => {}, 50);\n', end: 'timeout' },
    { name: 'loop', code: 'for (;;) {}\n', end: 'stop' },
    { name: 'flood', code: 'for (;;) console.log("y".repeat(200));\n', end: 'error' },
    { name: 'closed', code: 'close();\n', end: 'timeout' },
  ] as const;

  for (const [i, s] of scenarios.entries()) {
    if (i > 0) await app.addTab();
    await app.setLanguage('javascript');
    await replaceCode(app, s.code);
    await app.typeCode(`// before-${s.name}`);

    const run = await startRun(page);
    await withWatchdog(`type during ${s.name}`, 10_000, () => app.typeCode(` during-${s.name}`));
    if (s.end === 'stop') await stopRun(page);
    expect(await waitOutcome(page, run)).toBe(s.end === 'stop' ? 'aborted' : s.end);
  }

  await app.waitForSynced();
  const zipPath = await app.exportAllTabs();
  const sources = (await listZipEntries(zipPath)).filter((n) => n.endsWith('.js'));
  const contents = await Promise.all(sources.map((n) => readZipEntryText(zipPath, n)));
  for (const s of scenarios) {
    expect(
      contents.some((c) => c.includes(`// before-${s.name} during-${s.name}`)),
      `${s.name}: edits before and during the run are in the exported source`
    ).toBe(true);
  }

  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
});

test('/author でスターターコードを JS で実行しても #author-jwk に届かない', async ({ page }) => {
  await installTermsAccepted(page);
  await page.goto('/author');
  await page.locator('#author-starter-editor .view-lines').waitFor({ state: 'visible', timeout: BOOT_TIMEOUT_MS });
  await page.locator('#author-jwk').fill('{"d":"SECRET-AUTHOR-KEY"}');

  // スターターのファイル名を .js にする (タブのダブルクリックで改名)。本物の 2 回クリックは
  // 1 回目のクリックでタブが描き直されて dblclick が届かないので、dblclick だけを送る
  await page.locator('#author-tabs .tab-filename').first().dispatchEvent('dblclick');
  const input = page.locator('#author-tabs .tab-filename-input');
  await input.fill('p1.js');
  await input.press('Enter');
  await expect(page.locator('#author-tabs .tab-filename').first()).toHaveText('p1.js');

  await page.locator('#author-starter-editor .view-lines').click();
  await page.keyboard.insertText(
    'try { console.log("jwk:" + document.getElementById("author-jwk").value); } catch (e) { console.error("jwk:blocked"); }'
  );

  const terminal = '#author-terminal';
  const run = await startRun(page, '#author-run-btn', terminal);
  expect(await waitOutcome(page, run, terminal)).toBe('success');
  await expect.poll(() => terminalText(page, terminal)).toContain('jwk:blocked');
  expect(await terminalText(page, terminal)).not.toContain('SECRET-AUTHOR-KEY');
});

test('/author でスターターコードを TS として実行できる', async ({ page }) => {
  await installTermsAccepted(page);
  await page.goto('/author');
  await page.locator('#author-starter-editor .view-lines').waitFor({ state: 'visible', timeout: BOOT_TIMEOUT_MS });

  // スターターのファイル名を .ts にする (上の JS の test と同じく dblclick だけを送る)
  await page.locator('#author-tabs .tab-filename').first().dispatchEvent('dblclick');
  const input = page.locator('#author-tabs .tab-filename-input');
  await input.fill('p1.ts');
  await input.press('Enter');
  await expect(page.locator('#author-tabs .tab-filename').first()).toHaveText('p1.ts');

  // 改行を含めない 1 行で入れる (上の JS の test と同じ流儀。改行で自動インデント・補完を通さない)
  await page.locator('#author-starter-editor .view-lines').click();
  await page.keyboard.insertText('interface P { n: number } const p: P = { n: 41 }; console.log("ts:" + (p.n + 1));');

  const terminal = '#author-terminal';
  const run = await startRun(page, '#author-run-btn', terminal);
  expect(await waitOutcome(page, run, terminal)).toBe('success');
  await expect.poll(() => terminalText(page, terminal)).toContain('ts:42');
});
