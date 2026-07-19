import { test, expect } from '@playwright/test';
import { EditorApp, readProofEvents } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * 内部ペースト: エディタ内で自分が書いた内容をコピペすると、SessionContentRegistry の
 * 照合で insertFromInternalPaste (許可) に格下げされ、外部ペーストと違って Pure Typing を
 * 崩さない (ADR の不変条件 #4 = ピュアタイピング判定の入口の実地検証)。
 */
test('内部コピペは insertFromInternalPaste として許可され Pure Typing: YES を保つ', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int helper = 7;');
  await app.selectAllCopyPaste();

  const zipPath = await app.exportCurrentTab();

  // proof に insertFromInternalPaste の監査イベントが残っている。
  const events = await readProofEvents(zipPath);
  const internal = events.find((e) => e.inputType === 'insertFromInternalPaste');
  expect(internal, 'insertFromInternalPaste audit event should be recorded').toBeTruthy();
  // 外部ペースト (insertFromPaste) は無いこと。
  expect(events.some((e) => e.inputType === 'insertFromPaste')).toBe(false);

  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  // 自分のコードの内部コピペは外部入力扱いにならない。
  expect(result.stdout).toContain('Pure Typing: YES');
  expect(result.stdout).toMatch(/0 external input/);
});
