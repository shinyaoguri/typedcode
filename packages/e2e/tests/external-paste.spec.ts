import { test, expect } from '@playwright/test';
import { EditorApp, readProofEvents } from './helpers/app.js';
import { runVerifyCliWithAnalysis } from './helpers/verifyCli.js';

/**
 * 外部ペースト: クリップボード経由の外部テキストを実ペーストすると insertFromPaste
 * として記録され、検証は通る (チェーンは valid) が advisory では Pure Typing: NO /
 * 外部入力あり になる。コピペ検出の中核。
 */
test('外部ペーストは insertFromPaste として記録され Pure Typing: NO になる', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int x = 1;\n');
  await app.pasteExternalText('PASTED_EXTERNAL_CODE');

  const zipPath = await app.exportCurrentTab();

  // proof に insertFromPaste イベントが残っている (ホワイトボックス)。
  const events = await readProofEvents(zipPath);
  const pasteEvent = events.find((e) => e.inputType === 'insertFromPaste');
  expect(pasteEvent, 'insertFromPaste event should be recorded').toBeTruthy();
  expect(pasteEvent?.data).toContain('PASTED_EXTERNAL_CODE');

  const result = runVerifyCliWithAnalysis(zipPath);
  // チェーンは valid (ペーストしても改ざんではない)。
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  // advisory: 純粋打鍵ではない + 外部入力あり。
  expect(result.stdout).toContain('Pure Typing: NO');
  expect(result.stdout).toMatch(/[1-9]\d* external input/);
  expect(result.analysis[0]!.valid).toBe(true);
});
