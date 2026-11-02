import { test, expect } from '@playwright/test';
import { EditorApp, installTermsAccepted } from './helpers/app.js';

/**
 * 多重起動 (#435): 同じ BrowserContext の 2 つのタブで同じモードを開くと、後から開いた側が
 * `SingleInstanceGuard` (BroadcastChannel `typedcode-instance-guard:<mode>` の ping → pong を 500ms 待つ)
 * で止まり `[data-dialog="duplicate-instance"]` を出す。チャンネルはモード別なので、別のモードなら
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
