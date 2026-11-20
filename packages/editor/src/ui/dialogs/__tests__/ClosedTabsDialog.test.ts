// @vitest-environment happy-dom
/**
 * 閉じたタブの一覧 (#317)。一覧は渡された順 (閉じた時刻の新しい順) に並び、行の状態契約を持つ。
 * 「開き直す」が成功したらダイアログを閉じ、失敗したら一覧を残して知らせる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchivedTabSummary } from '../../../services/SessionStorageService.js';

vi.mock('../../../i18n/index.js', () => ({
  t: (key: string) => key,
}));

const { showClosedTabsDialog } = await import('../ClosedTabsDialog.js');

const tabs: ArchivedTabSummary[] = [
  { id: 'new', sessionId: 's2', filename: 'b.py', language: 'python', archivedAt: 200, eventCount: 5 },
  { id: 'old', sessionId: 's1', filename: '<a>.c', language: 'c', archivedAt: 100, eventCount: 12 },
];

const overlay = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-dialog="closed-tabs"]');
const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.closed-tab-item'));
const reopenButton = (tabId: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`.closed-tab-item[data-tab-id="${tabId}"] [data-action="reopen"]`)!;

/** ボタンの click ハンドラ (async) と showModal の閉じる処理 (200ms) を進める */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  vi.advanceTimersByTime(500);
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('showClosedTabsDialog (#317)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('lists the closed tabs in the given order with the state contract on each row', () => {
    void showClosedTabsDialog(tabs, { reopen: vi.fn(), notify: vi.fn(), formatTime: String });

    expect(overlay()?.dataset.count).toBe('2');
    expect(
      rows().map((r) => ({
        id: r.dataset.tabId,
        filename: r.dataset.filename,
        language: r.dataset.language,
        archivedAt: r.dataset.archivedAt,
        eventCount: r.dataset.eventCount,
      }))
    ).toEqual([
      { id: 'new', filename: 'b.py', language: 'python', archivedAt: '200', eventCount: '5' },
      { id: 'old', filename: '<a>.c', language: 'c', archivedAt: '100', eventCount: '12' },
    ]);
    // ファイル名は HTML として解釈しない
    expect(rows()[1]!.querySelector('.closed-tab-name')?.textContent).toContain('<a>.c');
  });

  it('shows an empty state with count 0 when there is no closed tab', () => {
    void showClosedTabsDialog([], { reopen: vi.fn(), notify: vi.fn() });

    expect(overlay()?.dataset.count).toBe('0');
    expect(rows()).toHaveLength(0);
    expect(document.querySelector('.closed-tabs-empty')).not.toBeNull();
  });

  it('reopens the chosen tab and closes the dialog when reopening succeeds', async () => {
    const reopen = vi.fn(async () => true);
    const closed = showClosedTabsDialog(tabs, { reopen, notify: vi.fn() });

    reopenButton('old').click();
    await flush();

    expect(reopen).toHaveBeenCalledWith('old');
    await closed;
    expect(overlay()).toBeNull();
  });

  it('keeps the list open, re-enables the buttons and notifies when reopening fails', async () => {
    const notify = vi.fn();
    const reopen = vi.fn(async () => false);
    void showClosedTabsDialog(tabs, { reopen, notify });

    reopenButton('new').click();
    expect(reopenButton('old').disabled).toBe(true);
    await flush();

    expect(overlay()).not.toBeNull();
    expect(notify).toHaveBeenCalledWith('closedTabs.reopenFailed');
    expect(reopenButton('old').disabled).toBe(false);
  });

  it('ignores a second reopen while the first one is running', async () => {
    let finish!: (value: boolean) => void;
    const reopen = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    void showClosedTabsDialog(tabs, { reopen, notify: vi.fn() });

    reopenButton('new').click();
    reopenButton('old').click();
    finish(true);
    await flush();

    expect(reopen).toHaveBeenCalledTimes(1);
  });
});
