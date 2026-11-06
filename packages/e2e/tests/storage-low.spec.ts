import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { EditorApp } from './helpers/app.js';
import {
  STORAGE_PROBE_DB_NAME,
  failStorageProbe,
  injectQuotaExceeded,
  probeFailureCount,
  quotaFailureCount,
  type StorageProbeFailure,
} from './helpers/faults.js';

/**
 * 空き容量の不足を知らせる (#626)。
 * - 起動時の試験: セッション DB とは別の DB に書いて消す。書けなければ編集画面に進む前に警告
 *   (`[data-dialog="storage-low"]`) を出し、「このまま続ける」で起動を続けられる。書けたら何も出さず、試験用の
 *   DB を残さない。未知パスの not-found 画面 (#644) では試験しない
 * - 利用中: 保存が容量切れらしい失敗 (editor の `isStorageFullError`) になったら、容量不足の通知
 *   (`#block-notification[data-notice]`) を 1 回だけ出す
 *
 * 試験の失敗は 2 つの形で注入する: ブラウザの割り当てを超えたときの `QuotaExceededError` と、ディスクが本当に
 * 一杯のときに Chromium が返す `DataError: Failed to write blobs (IOError)` での transaction の abort (#626 の
 * 実ディスクでの再現。こちらは QuotaExceeded にならない)。
 *
 * dev サーバ (vite.editor.config.mjs) は試験の書き込み量を 1MB に縮めている。
 */

/** 容量不足の通知の id (`showNotification` の第 2 引数。main.ts) */
const STORAGE_FULL_NOTICE = 'storage-full';

/** 試験用 DB を開いた回数を数える init script を入れる (試験が走ったか / 走らなかったかを見る)。goto の前に呼ぶ */
async function countProbeOpens(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript((probeDbName) => {
    const w = window as unknown as { __tcProbeOpens?: number };
    w.__tcProbeOpens = 0;
    const originalOpen = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function open(this: IDBFactory, name: string, version?: number) {
      if (name === probeDbName) w.__tcProbeOpens = (w.__tcProbeOpens ?? 0) + 1;
      return originalOpen.call(this, name, version);
    };
  }, STORAGE_PROBE_DB_NAME);
}

function probeOpenCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __tcProbeOpens?: number }).__tcProbeOpens ?? 0);
}

async function databaseNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name ?? ''));
}

for (const failure of ['quota', 'ioError'] as const satisfies readonly StorageProbeFailure[]) {
  test(`#626 起動時の試験が書けない (${failure}) と警告が出て、「このまま続ける」で編集できる状態まで起動する`, async ({
    page,
  }) => {
    await failStorageProbe(page, failure);
    const app = new EditorApp(page);
    await page.goto('/casual');

    // 試験が書き込みに来て失敗し、編集画面に進む前に警告が出る
    await expect.poll(() => app.openDialogs()).toEqual(['storage-low']);
    expect(await probeFailureCount(page)).toBe(1);
    expect(await app.appState()).toBe('initializing');

    // 「もう一度確かめる」は試験をやり直す。まだ書けないので警告は開いたまま
    const dialog = page.locator('[data-dialog="storage-low"]');
    await dialog.locator('[data-action="retry"]').click();
    await expect.poll(() => probeFailureCount(page)).toBe(2);
    await expect(dialog.locator('[data-action="retry"]')).toBeEnabled();
    expect(await app.openDialogs()).toEqual(['storage-low']);

    // 「このまま続ける」で起動が続き、打鍵が保存される (セッション DB の保存は注入の対象外)
    await dialog.locator('[data-action="continue"]').click();
    await app.waitReady();
    expect(await app.appState()).toBe('ready');
    expect(await app.openDialogs()).not.toContain('storage-low');
    await app.typeCode('int q = 1;\n');
    await app.waitForSynced();
  });
}

test('#626 試験が書けた起動では警告が出ず、試験用の DB が残らない', async ({ page }) => {
  await countProbeOpens(page);
  const app = new EditorApp(page);
  await app.openCasualFresh();

  // 試験は走った (空振りで緑にしない)
  expect(await probeOpenCount(page)).toBeGreaterThan(0);
  expect(await app.openDialogs()).not.toContain('storage-low');
  expect(await databaseNames(page)).not.toContain(STORAGE_PROBE_DB_NAME);
});

test('#626 未知パスの not-found 画面では試験を走らせない', async ({ page }) => {
  await countProbeOpens(page);
  const app = new EditorApp(page);
  await page.goto('/exsm');
  await expect.poll(() => app.appState()).toBe('not-found');
  // 遅れて走る処理があっても拾えるよう、読み込みが落ち着くまで待ってから数える
  await page.waitForLoadState('networkidle');

  expect(await probeOpenCount(page)).toBe(0);
  expect(await databaseNames(page)).not.toContain(STORAGE_PROBE_DB_NAME);
});

test('#626 利用中に保存が容量切れ (QuotaExceeded) で失敗すると、容量不足の通知が 1 回だけ出る', async ({ page }) => {
  const app = new EditorApp(page);
  // 保存 (TabManager.persistAll) が IndexedDB で失敗した回数。通知の判定はこの失敗ごとに走るので、
  // 2 回目以降の失敗が起きたことを確かめてから通知の回数を見る (EventRecorder の 1 件ずつの保存の失敗は
  // 通知の判定を通らないので、quotaFailureCount だけでは 2 回目の判定を待てない)
  let persistFailures = 0;
  page.on('console', (msg) => {
    if (msg.type() === 'error' && msg.text().startsWith('[TabManager] Failed to save to IndexedDB')) {
      persistFailures += 1;
    }
  });
  await app.openCasualFresh();
  await app.typeCode('int q = 1;\n');
  await app.waitForSynced();

  // `#block-notification[data-notice]` に容量不足の id が書かれた回数を数える
  await page.evaluate((notice) => {
    const w = window as unknown as { __tcQuotaNotices?: number };
    w.__tcQuotaNotices = 0;
    const el = document.getElementById('block-notification');
    if (!el) throw new Error('#block-notification not found');
    new MutationObserver((records) => {
      for (const record of records) {
        if ((record.target as Element).getAttribute('data-notice') === notice) {
          w.__tcQuotaNotices = (w.__tcQuotaNotices ?? 0) + 1;
        }
      }
    }).observe(el, { attributes: true, attributeFilter: ['data-notice'] });
  }, STORAGE_FULL_NOTICE);
  const notices = () => page.evaluate(() => (window as unknown as { __tcQuotaNotices?: number }).__tcQuotaNotices ?? 0);

  await injectQuotaExceeded(page, 'idb');
  await app.typeCode('int r = 2;\n');
  await expect.poll(notices).toBe(1);
  await expect(page.locator('#sync-status-item')).toHaveAttribute('data-state', 'degraded', { timeout: 15_000 });
  expect(await quotaFailureCount(page)).toBeGreaterThan(0);

  // 次の保存 (打鍵と、2 秒後からの再試行) も容量切れで失敗するが、通知は増えない
  const failuresAtNotice = persistFailures;
  await app.typeCode('int s = 3;\n');
  await expect.poll(() => persistFailures, { timeout: 15_000 }).toBeGreaterThan(failuresAtNotice);
  expect(await notices()).toBe(1);
});
