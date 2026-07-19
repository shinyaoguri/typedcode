import { test, expect } from '@playwright/test';
import { EditorApp, listProofEntries } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * シナリオ9: 複数タブで打鍵 → 全タブ ZIP export → verify-cli が ZIP 内の
 * 全 proof を検証。マルチタブのエクスポート結線と CLI の ZIP 一括検証を担保する。
 */
test('casual: 複数タブを ZIP export → CLI が全 proof を検証', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();

  await app.typeCode('let first = 1;\n');
  await app.addTab();
  await app.typeCode('let second = 2;\n');

  const zipPath = await app.exportAllTabs();

  // ZIP に 2 つの proof が入っている。
  const entries = await listProofEntries(zipPath);
  expect(entries.length).toBe(2);

  // CLI は ZIP を直接受け取り、全 proof を検証して exit 0。
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  expect(result.stdout).toContain('Verification PASSED');
});
