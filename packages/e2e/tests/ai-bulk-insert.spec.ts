import { test, expect } from '@playwright/test';
import { EditorApp, readProofEvents } from './helpers/app.js';
import { runVerifyCliWithAnalysis } from './helpers/verifyCli.js';

const CODE_BLOCK = 'int compute(int a, int b) {\n  int r = a * b;\n  return r;\n}\n';

/**
 * 敵対的: Copilot/Cursor のように「AI が生成したコード全体を 1 つの編集で一気に投入する」
 * 挙動 (snippet 展開も同型) を再現し、proof に痕跡が残り後から検出できることを実ブラウザで
 * 実証する。Monaco の executeEdits は複数行を単一の insertParagraph として記録するため、
 * 1 文字ずつの打鍵 (benign) とは区別される。
 */
test('複数行コードの一括投入は記録され Pure Typing: NO / 外部入力として検出される', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('// solution\n');
  await app.injectCodeBlock(CODE_BLOCK);
  await app.waitForSynced();

  const zipPath = await app.exportCurrentTab();

  // 単一の contentChange に複数行コードが載っている (1 文字ずつではない)。
  const events = await readProofEvents(zipPath);
  const bulk = events.find(
    (e) => e.type === 'contentChange' && typeof e.data === 'string' && /[\r\n]/.test(e.data) && /\S/.test(e.data)
  );
  expect(bulk, 'a multi-line code contentChange should be recorded').toBeTruthy();
  expect(bulk?.data).toContain('int compute');

  const result = runVerifyCliWithAnalysis(zipPath);
  // チェーンは valid (実際の編集なので改ざんではない) が、advisory で確実に検出される。
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  expect(result.stdout).toContain('Pure Typing: NO');
  expect(result.stdout).toMatch(/[1-9]\d* external input/);
  // 分析シグナルに外部入力 (bulk insertion) が立つ。
  expect(result.analysis[0]!.valid).toBe(true);
});

/**
 * 対照: 同じコードを 1 文字ずつ打鍵すると (括弧自動閉じ等を含んでも) Pure Typing: YES。
 * 「一括投入」と「正規の打鍵」を分析層が区別できることを示す。
 */
test('同じコードを打鍵した場合は Pure Typing: YES (一括投入と区別される)', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int g() {\n  return 1;\n}\n');
  await app.waitForSynced();

  const zipPath = await app.exportCurrentTab();
  const result = runVerifyCliWithAnalysis(zipPath);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  expect(result.stdout).toContain('Pure Typing: YES');
  expect(result.stdout).toMatch(/0 external input/);
});
