import { test, expect } from '@playwright/test';
import { EditorApp, readProofEvents } from './helpers/app.js';
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
  // 括弧 `()` `{}` を含む普通のコードを打鍵する。Monaco の自動閉じ等が複数文字挿入を
  // 起こすが、shared 側で「1 キー入力→複数文字」の正規入力を benign 扱いするので
  // (structuralEdit.ts)、全打鍵が自分の手なら Pure Typing: YES になるべき。
  // 短めの本体にして CI での full PoSW 再計算コストを抑える (回帰観点は括弧の有無)。
  const code = 'int f() {\n  return 0;\n}\n';
  await app.typeCode(code);

  // 打鍵がエディタとイベントチェーンに反映されている。
  expect(await app.editorValue()).toContain('int f()');
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

  // ③ 起動時ワンショット信号 (#132): environmentProbe (ADR-0007 Tier0 + ADR-0019 の
  // editorAssist 宣言) と screenShareOptOut (casual は既定オプトアウト = ADR-0015) が
  // チェーンに載っている。EventRecorder 生成 (Phase 4.9) より前に発火して無音ドロップ
  // していた回帰の検出器。
  const events = await readProofEvents(zipPath);
  const probe = events.find((e) => e.type === 'environmentProbe');
  expect(probe, 'environmentProbe recorded at startup').toBeDefined();
  expect(
    (probe!.data as { editorAssist?: unknown } | undefined)?.editorAssist,
    'editorAssist declaration present in environmentProbe'
  ).toBeTruthy();
  expect(
    events.some((e) => e.type === 'screenShareOptOut'),
    'screenShareOptOut recorded at startup (casual defaults to opt-out)'
  ).toBe(true);
});
