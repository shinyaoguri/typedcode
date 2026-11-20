import { test, expect } from '@playwright/test';
import { EditorApp, readAllProofEvents } from '../helpers/app.js';
import { runVerifyCli } from '../helpers/verifyCli.js';
import {
  closeClosedTabs,
  closedTabRows,
  openClosedTabs,
  openClosedTabsUntilListed,
  reopenClosedTab,
} from '../helpers/closedTabs.js';
import { clickMainMenuItem, templateFile, waitDialogClosed, waitDialogOpen } from '../helpers/scenario.js';

/**
 * #317: 閉じたタブは消えずに残り、メインメニューの「閉じたタブ」(`[data-dialog="closed-tabs"]`) から開き直せる。
 * 一覧は閉じた時刻の新しい順に、ファイル名・言語・閉じた時刻・イベント数を出す。開き直したタブは同じ中身と
 * イベント数でアクティブになり、一覧から消える。打鍵を続けた export は verify-cli (fast) で pass する。
 * 閉じたタブはリロードで開いたタブとして蘇らない (#145)。
 */

/** タブ 1 本分の中身とイベント数 (snapshot) */
async function tabState(app: EditorApp, tabId: string): Promise<{ content: string; totalEvents: number }> {
  const tab = (await app.snapshot()).tabs.find((t) => t.id === tabId);
  if (!tab) throw new Error(`tab ${tabId} is not open`);
  return { content: tab.content, totalEvents: tab.totalEvents };
}

test('閉じたタブは新しい順に一覧に並び、開き直すと同じ中身とイベント数でアクティブになって一覧から消え、打鍵を続けた export が verify で pass する', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int a = 1;');
  await app.waitForSynced();
  const a = (await app.tabs())[0]!;
  const aBefore = await tabState(app, a.id);

  await app.addTab();
  await app.typeCode('int b = 2;');
  await app.waitForSynced();
  const b = (await app.tabs())[1]!;
  const bBefore = await tabState(app, b.id);
  await app.addTab();
  await app.waitForSynced();

  await app.requestCloseTab(a.id);
  await app.answerCloseTab('confirm');
  await openClosedTabsUntilListed(app, a.id);
  await closeClosedTabs(app);
  await app.requestCloseTab(b.id);
  await app.answerCloseTab('confirm');
  const rows = await openClosedTabsUntilListed(app, b.id);

  // 新しい順 (後に閉じた B が先)。ファイル名・言語・イベント数は閉じたときのタブのもの
  expect(rows.map(({ id, filename, language, eventCount }) => ({ id, filename, language, eventCount }))).toEqual([
    { id: b.id, filename: b.filename, language: b.language, eventCount: bBefore.totalEvents },
    { id: a.id, filename: a.filename, language: a.language, eventCount: aBefore.totalEvents },
  ]);
  expect(rows[0]!.archivedAt).toBeGreaterThanOrEqual(rows[1]!.archivedAt);
  await expect(page.locator('[data-dialog="closed-tabs"]')).toHaveAttribute('data-count', '2');

  // 閉じたタブはリロードで開いたタブとして蘇らない (#145)
  await closeClosedTabs(app);
  await app.reloadAndResume();
  expect((await app.tabs()).map((t) => t.id)).not.toContain(a.id);
  expect((await app.tabs()).map((t) => t.id)).not.toContain(b.id);

  await openClosedTabs(app);
  await reopenClosedTab(app, a.id);
  expect(await tabState(app, a.id)).toEqual(aBefore);
  await expect.poll(() => app.eventCount()).toBe(aBefore.totalEvents);
  await app.expectConsistent();

  await openClosedTabs(app);
  expect((await closedTabRows(app)).map((r) => r.id)).toEqual([b.id]);
  await closeClosedTabs(app);

  // 開き直したタブで記録が続き、export が verify-cli で通る
  await app.typeCode(' int more = 3;');
  await app.waitForSynced();
  expect((await tabState(app, a.id)).totalEvents).toBeGreaterThan(aBefore.totalEvents);
  const zipPath = await app.exportAllTabs();
  const proofs = await readAllProofEvents(zipPath);
  expect(proofs.size).toBe((await app.tabs()).length);
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  await app.expectConsistent();
});

test('最後のタブを閉じてもウェルカム画面から開き直せ、打鍵を続けた export が verify で pass する', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int last = 1;');
  await app.waitForSynced();
  const only = (await app.tabs())[0]!;
  const before = await tabState(app, only.id);

  await app.requestCloseTab(only.id);
  await app.answerCloseTab('confirm');
  await expect.poll(() => app.openDialogs()).toContain('welcome');
  expect(await app.tabs()).toEqual([]);

  await openClosedTabsUntilListed(app, only.id);
  await reopenClosedTab(app, only.id);
  expect(await app.openDialogs()).not.toContain('welcome');
  expect(await tabState(app, only.id)).toEqual(before);

  await app.typeCode(' int again = 2;');
  await app.waitForSynced();
  const zipPath = await app.exportAllTabs();
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  await app.expectConsistent();
});

test('テンプレートを取り込むと、取り込む前のタブは閉じたタブとして一覧に残る', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int before_template;');
  await app.waitForSynced();
  const previous = (await app.tabs())[0]!;
  const before = await tabState(app, previous.id);

  const chooser = page.waitForEvent('filechooser');
  await clickMainMenuItem(page, 'import-template-btn');
  await (await chooser).setFiles(
    templateFile('closed-tabs', [{ filename: 'main.c', language: 'c', content: 'int main(void) { return 0; }\n' }])
  );
  await waitDialogOpen(app, 'template-import');
  await page.locator('#template-confirm-btn').click();
  await waitDialogClosed(app, 'template-import');
  await waitDialogClosed(app, 'template-progress');
  await app.waitReady();

  const rows = await openClosedTabsUntilListed(app, previous.id);
  expect(rows.find((r) => r.id === previous.id)?.eventCount).toBe(before.totalEvents);
  await reopenClosedTab(app, previous.id);
  expect((await tabState(app, previous.id)).content).toBe(before.content);
  await app.expectConsistent();
});
