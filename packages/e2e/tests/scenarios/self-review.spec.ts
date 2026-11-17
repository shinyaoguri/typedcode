import { test, expect } from '@playwright/test';
import { EditorApp, readProofEvents } from '../helpers/app.js';
import { runVerifyCli } from '../helpers/verifyCli.js';
import { exportWithNote, openSelfReviewForExport, waitDialogClosed } from '../helpers/scenario.js';

/**
 * #434-11: 提出前セルフレビュー (ADR-0022, `data-dialog="self-review"`)。キャンセル (`data-action="cancel"`。
 * ボタンと × の 2 つ) では export が止まって何もダウンロードされず、書きかけのノートも記録されない。
 * 続行 (`data-action="proceed"`) すると、書いたノートが proof の `reflectionNote` に入って verify (fast) で pass する。
 */
test('セルフレビューはキャンセルでは何も出さず、続行するとノートが reflectionNote として proof に載る', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int a;');
  await app.waitForSynced();

  const downloads: string[] = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));

  // キャンセルのボタンと × のどちらでも、書きかけのノートごと中止になる。
  const cancels = page.locator('[data-dialog="self-review"] [data-action="cancel"]');
  for (const index of [0, 1]) {
    await openSelfReviewForExport(app);
    await expect(cancels).toHaveCount(2);
    await page.locator('#self-review-note').fill(`discarded ${index}`);
    await cancels.nth(index).click();
    await waitDialogClosed(app, 'self-review');
    await app.expectConsistent();
  }

  const note = 'ループの終了条件で迷った';
  const zipPath = await exportWithNote(app, note);
  // 続行した 1 回分だけがダウンロードされる (キャンセルした 2 回は何も出していない)。
  expect(downloads).toHaveLength(1);
  // ダウンロードはメニューを持たないボタン 1 つで、押すとそのまま書き出しが始まる (#779)。
  // 「現在のタブ」の書き出しもメニューも無い
  await expect(page.locator('#download-btn')).not.toHaveAttribute('aria-controls');
  await expect(page.locator('#download-dropdown')).toHaveCount(0);
  await expect(page.locator('#export-current-tab-btn')).toHaveCount(0);

  const notes = (await readProofEvents(zipPath)).filter((e) => e.type === 'reflectionNote');
  expect(notes.map((e) => (e.data as { text?: string }).text)).toEqual([note]);
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  await app.expectConsistent();
});
