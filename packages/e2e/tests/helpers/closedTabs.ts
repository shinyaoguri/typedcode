import { expect } from '@playwright/test';
import type { EditorApp } from './app.js';
import { clickMainMenuItem, waitDialogClosed, waitDialogOpen } from './scenario.js';

/**
 * 閉じたタブ (#317) の操作と読み出し。読むのは状態契約 (`[data-dialog="closed-tabs"]` の `data-count` と
 * `.closed-tab-item` の data-*) だけ。
 */

/** 一覧の 1 行 (`.closed-tab-item` の data-*) */
export interface ClosedTabRow {
  id: string;
  filename: string;
  language: string;
  archivedAt: number;
  eventCount: number;
}

/** メインメニューの「閉じたタブ」を押して一覧を開く */
export async function openClosedTabs(app: EditorApp): Promise<void> {
  await clickMainMenuItem(app.page, 'closed-tabs-btn');
  await waitDialogOpen(app, 'closed-tabs');
}

/** 開いている一覧の行 (表示順 = 閉じた時刻の新しい順) */
export function closedTabRows(app: EditorApp): Promise<ClosedTabRow[]> {
  return app.page.locator('[data-dialog="closed-tabs"] .closed-tab-item').evaluateAll((els) =>
    (els as HTMLElement[]).map((el) => ({
      id: el.dataset.tabId ?? '',
      filename: el.dataset.filename ?? '',
      language: el.dataset.language ?? '',
      archivedAt: Number(el.dataset.archivedAt),
      eventCount: Number(el.dataset.eventCount),
    }))
  );
}

/** 一覧を閉じる (`data-action="close"`) */
export async function closeClosedTabs(app: EditorApp): Promise<void> {
  await app.page.locator('[data-dialog="closed-tabs"] .modal-footer [data-action="close"]').click();
  await waitDialogClosed(app, 'closed-tabs');
}

/**
 * 一覧を開き、`tabId` の行が載るまで待つ (閉じたタブの書き込みは閉じた後に非同期で終わるので、
 * 載っていなければ一覧を開き直す)。開いた一覧の行を返す
 */
export async function openClosedTabsUntilListed(app: EditorApp, tabId: string): Promise<ClosedTabRow[]> {
  let rows: ClosedTabRow[] = [];
  await expect
    .poll(
      async () => {
        await openClosedTabs(app);
        rows = await closedTabRows(app);
        if (rows.some((row) => row.id === tabId)) return true;
        await closeClosedTabs(app);
        return false;
      },
      { timeout: 30_000, message: `closed tab ${tabId} is listed` }
    )
    .toBe(true);
  return rows;
}

/** 開いている一覧で `tabId` の「開き直す」を押し、一覧が閉じてそのタブがアクティブになるまで待つ */
export async function reopenClosedTab(app: EditorApp, tabId: string): Promise<void> {
  await app.page
    .locator(`[data-dialog="closed-tabs"] .closed-tab-item[data-tab-id="${tabId}"] [data-action="reopen"]`)
    .click();
  await waitDialogClosed(app, 'closed-tabs');
  await expect(app.page.locator(`#editor-tabs .editor-tab[data-tab-id="${tabId}"]`)).toHaveAttribute(
    'data-active',
    'true'
  );
}
