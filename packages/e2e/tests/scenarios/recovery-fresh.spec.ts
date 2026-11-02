import { test, expect } from '@playwright/test';
import { EditorApp, readProofEvents } from '../helpers/app.js';
import { runVerifyCli } from '../helpers/verifyCli.js';
import { waitDialogClosed, waitDialogOpen } from '../helpers/scenario.js';

/**
 * #434-4: ブラウザタブを閉じた後の再訪で、復旧ダイアログ (`data-dialog="session-recovery"`) から
 * 「新規開始」を選ぶ。前のタブは引き継がれず (id も中身も残らない)、新しいセッションの proof に
 * sessionResumed は載らず、verify-cli (fast) で pass する。「再開」側は close-tab-recovery.spec.ts が持つ。
 */
test('タブを閉じて再訪し、復旧ダイアログで新規開始を選ぶと前のタブを引き継がずに始まり verify が pass する', async ({
  page,
  context,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int old = 1;\n');
  await app.waitForSynced();
  const oldIds = (await app.tabs()).map((t) => t.id);
  await page.close();

  const page2 = await context.newPage();
  const app2 = new EditorApp(page2);
  await page2.goto('/casual');
  await waitDialogOpen(app2, 'session-recovery');
  expect(await app2.appState()).toBe('initializing');
  await page2.locator('#session-fresh-btn').click();
  await waitDialogClosed(app2, 'session-recovery');
  await app2.waitReady();
  await app2.expectConsistent();

  const snap = await app2.snapshot();
  expect(snap.tabs.length).toBeGreaterThan(0);
  for (const tab of snap.tabs) {
    expect(oldIds, 'no tab of the previous session survives').not.toContain(tab.id);
    expect(tab.content).toBe('');
  }

  await app2.typeCode('int fresh = 2;\n');
  await app2.waitForSynced();
  const zipPath = await app2.exportCurrentTab();
  const events = await readProofEvents(zipPath);
  expect(events.some((e) => e.type === 'sessionResumed')).toBe(false);
  expect(JSON.stringify(events)).not.toContain('old = 1');
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  await app2.expectConsistent();
});
