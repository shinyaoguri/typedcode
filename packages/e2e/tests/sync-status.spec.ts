import { test, expect } from '@playwright/test';
import { EditorApp, listProofEntries } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * #456: 打鍵前のタブを export しても、同期状態 (`#sync-status-item[data-state]`) が `synced` に戻る。
 *
 * export の pre-export attestation の記録は保存を要求して `pending` にし、直後の flush が
 * そのデバウンス中の保存を取り消して自分で保存する。flush が状態を確定させないと、後に
 * イベントが来ない (打鍵していない) タブでは `pending` のまま止まっていた。
 */
test('casual: 打鍵せずに現タブを export しても同期状態が synced に戻る (#456)', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();

  const zipPath = await app.exportCurrentTab();
  expect(await listProofEntries(zipPath)).toHaveLength(1);

  await app.waitForSynced();
  await app.expectConsistent();

  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
});
