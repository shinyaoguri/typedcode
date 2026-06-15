import { test, expect } from '@playwright/test';
import { EditorApp, extractProofJson } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * シナリオ10 (負のオラクル): export した本物の proof を 1 箇所だけ書き換えると
 * verify-cli が改ざんを検出して exit 1 になること。これがないと「何でも pass する
 * 壊れた検証器」を取りこぼす。改ざん前は pass する positive control も併せて確認。
 */
test('改ざんした proof を CLI が拒否する (無改ざんは pass)', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int main(void) {\n  return 0;\n}\n');

  const zipPath = await app.exportCurrentTab();

  // positive control: 無改ざんで取り出した proof.json は pass (exit 0)。
  const cleanPath = await extractProofJson(zipPath);
  const clean = runVerifyCli(cleanPath);
  expect(clean.passed, 'unmodified proof should pass\n' + clean.stdout + clean.stderr).toBe(true);

  // negative oracle: 中ほどの content-change イベントの data を 1 文字だけ書き換える。
  // hash を再計算しないのでハッシュチェーンが切れ、検証は失敗するべき。
  const tamperedPath = await extractProofJson(zipPath, (proof) => {
    const tp = (proof.proof ?? proof) as { events?: Array<Record<string, unknown>> };
    const events = tp.events ?? [];
    const target = events.find(
      (e) => e.type === 'contentChange' && typeof e.data === 'string' && (e.data as string).length > 0,
    );
    if (!target) throw new Error('no content-change event with data to tamper');
    target.data = `${'​'}${target.data as string}`; // ゼロ幅文字を挿入して内容を改変
  });
  const tampered = runVerifyCli(tamperedPath);
  expect(tampered.passed, 'tampered proof must be rejected\n' + tampered.stdout).toBe(false);
  expect(tampered.exitCode).toBe(1);
});
