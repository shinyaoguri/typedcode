// @vitest-environment happy-dom
/**
 * メインメニューの「閉じたタブ」(#317)。exam では項目を出さない (exam は閉じたタブを残さない)。
 * それ以外では押すと一覧を開き、開き直せたらウェルカム画面を閉じてキャプチャを再開する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../../core/AppContext.js';

vi.mock('../../i18n/index.js', () => ({
  t: (key: string) => key,
}));

const { setupClosedTabsMenu } = await import('../closedTabs.js');

function context(mode: AppContext['mode'], tabManager: Partial<NonNullable<AppContext['tabManager']>> | null) {
  return {
    mode,
    mainMenuDropdown: { close: vi.fn() },
    tabManager,
    tabUIController: { updateUI: vi.fn() },
    trackers: { screenshot: { setCaptureEnabled: vi.fn() } },
    welcomeScreen: null,
  } as unknown as AppContext;
}

describe('setupClosedTabsMenu (#317)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<button id="closed-tabs-btn">Closed tabs</button>';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('removes the menu item in exam mode', () => {
    setupClosedTabsMenu(context('exam', null), { notify: vi.fn(), afterReopen: vi.fn() });
    expect(document.getElementById('closed-tabs-btn')).toBeNull();
  });

  it('keeps the menu item and opens the list of closed tabs in the other modes', async () => {
    const listArchivedTabs = vi.fn(async () => [
      { id: 't1', sessionId: 's', filename: 'a.c', language: 'c', archivedAt: 1, eventCount: 3 },
    ]);
    const ctx = context('casual', { listArchivedTabs } as never);
    setupClosedTabsMenu(ctx, { notify: vi.fn(), afterReopen: vi.fn() });

    document.getElementById('closed-tabs-btn')!.click();

    await vi.waitFor(() => expect(document.querySelector('[data-dialog="closed-tabs"]')).not.toBeNull());
    expect(ctx.mainMenuDropdown.close).toHaveBeenCalled();
    expect(document.querySelector('.closed-tab-item')?.getAttribute('data-tab-id')).toBe('t1');
  });

  it('notifies instead of opening the list when the closed tabs cannot be read', async () => {
    const notify = vi.fn();
    const listArchivedTabs = vi.fn(async () => {
      throw new Error('blocked');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setupClosedTabsMenu(context('class', { listArchivedTabs } as never), { notify, afterReopen: vi.fn() });

    document.getElementById('closed-tabs-btn')!.click();

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('closedTabs.loadFailed'));
    expect(document.querySelector('[data-dialog="closed-tabs"]')).toBeNull();
  });

  it('enables capture again and runs the after-reopen hook once a tab is reopened', async () => {
    const afterReopen = vi.fn();
    const reopenArchivedTab = vi.fn(async () => ({ id: 't1' }));
    const ctx = context('assignment', {
      listArchivedTabs: vi.fn(async () => [
        { id: 't1', sessionId: 's', filename: 'a.c', language: 'c', archivedAt: 1, eventCount: 3 },
      ]),
      reopenArchivedTab,
    } as never);
    setupClosedTabsMenu(ctx, { notify: vi.fn(), afterReopen });

    document.getElementById('closed-tabs-btn')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-action="reopen"]')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('[data-action="reopen"]')!.click();

    await vi.waitFor(() => expect(afterReopen).toHaveBeenCalledTimes(1));
    expect(reopenArchivedTab).toHaveBeenCalledWith('t1');
    expect(ctx.trackers.screenshot?.setCaptureEnabled).toHaveBeenCalledWith(true);
  });
});
