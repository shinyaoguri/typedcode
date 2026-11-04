import { test, expect } from '@playwright/test';
import { EditorApp, installTermsAccepted } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * 多重起動 (#435): 同じ BrowserContext の 2 つのタブで同じモードを開くと、後から開いた側が
 * `SingleInstanceGuard` (Web Locks `typedcode-instance-guard:<mode>` を `ifAvailable` で求め、取れなければ
 * 既存あり。#494) で止まり `[data-dialog="duplicate-instance"]` を出す。ロックはモード別なので、別のモードなら
 * 両方とも編集できる。
 *
 * 2 ページ目は `?reset` を付けずに開く (付けると 1 ページ目が開いている DB まで消しに行く)。
 */

test('同じモードを 2 つのタブで開くと、後から開いた側に duplicate-instance が出る', async ({ page, context }) => {
  const first = new EditorApp(page);
  await first.openCasualFresh();
  await expect.poll(() => first.appState()).toBe('ready');

  const page2 = await context.newPage();
  const second = new EditorApp(page2);
  await page2.goto('/casual');

  await expect.poll(() => second.openDialogs(), { timeout: 15_000 }).toContain('duplicate-instance');
  // 後から開いた側は編集に進まない。先に開いた側は影響を受けない。
  expect(await second.appState()).toBe('initializing');
  expect(await first.openDialogs()).not.toContain('duplicate-instance');
  await first.typeCode('int a = 1;\n');
  await first.expectConsistent();
});

test('別のモード (casual と assignment) なら、2 つのタブの両方で編集できる', async ({ page, context }) => {
  const casual = new EditorApp(page);
  await casual.openCasualFresh();
  await expect.poll(() => casual.appState()).toBe('ready');

  const page2 = await context.newPage();
  const assignment = new EditorApp(page2);
  await installTermsAccepted(page2);
  await page2.goto('/assignment');
  // assignment は起動時にタブを作らない (ウェルカム画面)。新規ファイルで始める。
  await expect.poll(() => assignment.openDialogs(), { timeout: 30_000 }).toContain('welcome');
  expect(await assignment.openDialogs()).not.toContain('duplicate-instance');
  await page2.locator('#welcome-new-file').click();
  await expect.poll(() => assignment.eventCount(), { timeout: 30_000 }).toBeGreaterThan(0);

  await assignment.typeCode('int b = 2;');
  await assignment.expectConsistent();
  expect((await assignment.snapshot()).tabs.map((t) => t.content)).toEqual(['int b = 2;']);

  await casual.typeCode('int a = 1;');
  await casual.expectConsistent();
  expect((await casual.snapshot()).tabs.map((t) => t.content)).toEqual(['int a = 1;']);
  expect(await casual.openDialogs()).not.toContain('duplicate-instance');
});

/**
 * #483: 離脱確認 (beforeunload) で「このページに留まる」を選ぶと、アンロードは起きないのにガードが
 * 破棄され、2 つ目のタブが正規インスタンスとして起動できてしまった。破棄は pagehide (persisted=false)
 * に移したので、留まったページのガードは生きている。
 * 離脱確認は記録のあるタブ (events > 0) を閉じようとしたときに出る (`beforeUnloadGuard.ts`)。
 */
test('離脱確認で「留まる」を選んだ後に同じモードを開くと、後から開いた側が duplicate-instance で止まる (#483)', async ({
  page,
  context,
}) => {
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  const first = new EditorApp(page);
  await first.openCasualFresh();
  await first.typeCode('int a = 1;\n');
  await first.waitForSynced();

  await page.close({ runBeforeUnload: true });
  // close() はダイアログの処理を待たずに返るので、出るのを待つ。dismiss したのでタブは閉じない。
  await expect.poll(() => dialogs).toEqual(['beforeunload']);
  expect(page.isClosed()).toBe(false);

  const page2 = await context.newPage();
  const second = new EditorApp(page2);
  await page2.goto('/casual');

  await expect.poll(() => second.openDialogs(), { timeout: 15_000 }).toContain('duplicate-instance');
  expect(await second.appState()).toBe('initializing');
  // 留まったページはそのまま編集を続けられ、チェーンも整合している。
  await first.typeCode('int b = 2;\n');
  await first.expectConsistent();
});

/**
 * #494: 同じモードで ready のページから `window.open` で開いたページ (opener を持つ popup) も、
 * `duplicate-instance` で止まる。popup は開いた側と同じ renderer の main thread で動くので、
 * 開かれた側の初期化の長いタスクの間は開いた側が ping に答えられず、pong の待ち時間 (500ms) が
 * 先に切れてガードをすり抜け、復旧ダイアログ (`session-recovery`) で止まっていた。判定を時間に
 * 依存しない Web Locks に移して直した。
 */
test('window.open で開いた同じモードのページも duplicate-instance で止まり、開いた側の記録は変わらない (#494)', async ({
  page,
}) => {
  const first = new EditorApp(page);
  await first.openCasualFresh();
  await first.typeCode('int a = 1;\n');
  await first.waitForSynced();
  const tabsOf = async (app: EditorApp) =>
    (await app.snapshot()).tabs.map((t) => ({ id: t.id, filename: t.filename, content: t.content }));
  const before = await tabsOf(first);

  const popupP = page.waitForEvent('popup');
  await page.evaluate(() => {
    window.open('/casual', '_blank');
  });
  const second = new EditorApp(await popupP);

  await expect.poll(() => second.openDialogs(), { timeout: 15_000 }).toContain('duplicate-instance');
  expect(await second.openDialogs()).not.toContain('session-recovery');
  expect(await second.appState()).toBe('initializing');

  // 開いた側はタブ構成も記録もそのままで、続けて書いた分も含めて export が検証を通る。
  await page.bringToFront();
  expect(await first.openDialogs()).not.toContain('duplicate-instance');
  expect(await tabsOf(first)).toEqual(before);
  await first.typeCode('int b = 2;\n');
  await first.expectConsistent();
  await first.waitForSynced();
  const zipPath = await first.exportCurrentTab();
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
});
