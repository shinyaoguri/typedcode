import { test, expect } from '@playwright/test';
import { EditorApp } from './helpers/app.js';
import { runVerifyCliWithAnalysis } from './helpers/verifyCli.js';

/**
 * シナリオ1 (happy path): /casual で実際にコードを打鍵 → export →
 * verify-cli が検証 pass。記録系 (editor) → 検証系 (shared/CLI) の round-trip が
 * 通ることを暗号的成果物で確認する基準テスト。
 */
test('casual: 打鍵→export→CLI 検証が pass する', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();

  const initialCount = await app.eventCount();
  // 括弧/クォートのペアは Monaco の自動補完が 2 文字挿入を起こし「外部入力」として
  // 記録される (Pure Typing: NO になる)。純粋打鍵を担保したいので括弧ペアを避ける。
  const code = 'int total = 0;\ntotal = total + 1;\ntotal = total * 2;\n';
  await app.typeCode(code);

  // 打鍵がエディタとイベントチェーンに反映されている。
  expect(await app.editorValue()).toContain('int total = 0;');
  expect(await app.eventCount()).toBeGreaterThan(initialCount);

  const zipPath = await app.exportCurrentTab();
  const result = runVerifyCliWithAnalysis(zipPath);

  // ① チェーン検証が pass (exit 0)。
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  expect(result.stdout).toContain('Verification PASSED');
  // 純粋打鍵 (ペースト/ドロップなし) として記録されている。
  expect(result.stdout).toContain('Pure Typing: YES');

  // ② analysis レポート (advisory) も valid を返し、ペースト由来の指摘がない。
  expect(result.analysis.length).toBeGreaterThan(0);
  expect(result.analysis[0]!.valid).toBe(true);
});
