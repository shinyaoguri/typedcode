import { test, expect } from '@playwright/test';
import { EditorApp, listProofEntries } from './helpers/app.js';
import { injectTransactionAbort, quotaFailureCount, transactionAbortCount } from './helpers/faults.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * 保存の transaction が request の success の後に abort される障害 (#543 / #300 の受け入れ条件 2)。
 *
 * 修正前は、`appendEvent` が `onabort` を待たずに永遠に settle せず、保存 (`executeSave`) が終わらないので
 * 同期状態は `syncing` のまま固まり、export も前の保存 (`flushToIndexedDB`) を待ってハングした。
 * 期待: 10 秒以内に、sessionStorage も失敗していれば `failed`、IndexedDB だけなら `degraded` になり、
 * その状態のまま全タブ export が ZIP のダウンロードまで終わる。
 *
 * abort は IndexedDB にしか効かないので、`failed` は `Storage.prototype.setItem` の失敗を重ねて確かめる
 * (#543 の着手プラン「条件 2 の読み方」)。QuotaExceeded の注入は `fault-storage.spec.ts`。
 */

/** 打鍵の後、失敗の状態に変わるまでの上限 (#300 の受け入れ条件 2) */
const FAILURE_VISIBLE_WITHIN_MS = 10_000;

for (const [scope, expected] of [
  ['idbAndSessionStorage', 'failed'],
  ['idb', 'degraded'],
] as const) {
  test(`#300 保存の transaction が success の後に abort されると (${scope})、10 秒以内に ${expected} になり、export もハングしない`, async ({
    page,
  }) => {
    const app = new EditorApp(page);
    await app.openCasualFresh();
    await app.typeCode('int q = 1;\n');
    await app.waitForSynced();

    await injectTransactionAbort(page, scope);
    await app.typeCode('int r = 2;\n');

    await expect(page.locator('#sync-status-item')).toHaveAttribute('data-state', expected, {
      timeout: FAILURE_VISIBLE_WITHIN_MS,
    });
    // 注入が効いた (保存の transaction を abort させた。setItem の失敗も重ねたなら、それも投げた)
    expect(await transactionAbortCount(page)).toBeGreaterThan(0);
    if (scope === 'idbAndSessionStorage') expect(await quotaFailureCount(page)).toBeGreaterThan(0);

    const zipPath = await app.exportAllTabs();
    expect(await listProofEntries(zipPath)).toHaveLength(1);
    const result = runVerifyCli(zipPath, ['--mode', 'fast']);
    expect(result.passed, result.stdout + result.stderr).toBe(true);
  });
}
