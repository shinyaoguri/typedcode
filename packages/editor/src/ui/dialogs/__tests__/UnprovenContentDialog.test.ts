// @vitest-environment happy-dom
/**
 * 復元時に証明と食い違った元のコードの通知 (#413 の受け入れ条件 1・3)。
 *
 * 差分の表示 (Monaco) とダウンロードは依存として差し替え、状態契約 (data-*) で確かめる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RestoreDivergence } from '../../tabs/TabManager.js';
import { showUnprovenContentDialog, type UnprovenContentDialogDeps } from '../UnprovenContentDialog.js';

const appended: RestoreDivergence = {
  tabId: 'tab-1',
  filename: 'main',
  language: 'c',
  original: 'int x;PENDING',
  chainContent: 'int x;',
};

const deleted: RestoreDivergence = {
  tabId: 'tab-2',
  filename: 'util',
  language: 'python',
  original: 'ac',
  chainContent: 'abc',
};

function fakeDeps() {
  const diffs: { container: HTMLElement; divergence: RestoreDivergence; dispose: ReturnType<typeof vi.fn> }[] = [];
  const downloads: { blob: Blob; filename: string }[] = [];
  const deps: UnprovenContentDialogDeps = {
    createDiffView: (container, divergence) => {
      const dispose = vi.fn();
      diffs.push({ container, divergence, dispose });
      return { dispose };
    },
    download: (blob, filename) => downloads.push({ blob, filename }),
  };
  return { deps, diffs, downloads };
}

const overlay = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-dialog="unproven-content"]');
const row = (tabId: string): HTMLElement =>
  overlay()!.querySelector<HTMLElement>(`.unproven-item[data-tab-id="${tabId}"]`)!;
const click = (tabId: string, action: string): void =>
  row(tabId).querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!.click();

describe('showUnprovenContentDialog (#413)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('opens nothing when no tab diverged', async () => {
    const done = showUnprovenContentDialog([], fakeDeps().deps);

    expect(overlay()).toBeNull();
    await done;
  });

  it('lists each diverged tab with the original and proof lengths instead of a trailing count', () => {
    void showUnprovenContentDialog([appended, deleted], fakeDeps().deps);

    const rows = [...overlay()!.querySelectorAll<HTMLElement>('.unproven-item')];
    expect(rows.map((r) => [r.dataset.tabId, r.dataset.originalLength, r.dataset.chainLength])).toEqual([
      ['tab-1', '13', '6'],
      ['tab-2', '2', '3'],
    ]);
  });

  it('shows the diff of the chosen tab, proof version against the original, when its show-diff button is clicked', () => {
    const { deps, diffs } = fakeDeps();
    void showUnprovenContentDialog([appended, deleted], deps);

    click('tab-2', 'show-diff');

    expect(diffs.map((d) => d.divergence)).toEqual([deleted]);
    expect(overlay()!.querySelector<HTMLElement>('.unproven-diff')!.dataset.diffTabId).toBe('tab-2');
  });

  it('replaces the open diff when another tab diff is requested', () => {
    const { deps, diffs } = fakeDeps();
    void showUnprovenContentDialog([appended, deleted], deps);

    click('tab-1', 'show-diff');
    click('tab-2', 'show-diff');

    expect(diffs[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it('downloads the original code of the tab as an UNPROVEN_ file named like the normal export', async () => {
    const { deps, downloads } = fakeDeps();
    void showUnprovenContentDialog([appended], deps);

    click('tab-1', 'download');

    expect(downloads.map((d) => d.filename)).toEqual(['UNPROVEN_main.c']);
    expect(await downloads[0]!.blob.text()).toBe('int x;PENDING');
  });

  it('disposes the open diff when the dialog is closed', async () => {
    const { deps, diffs } = fakeDeps();
    const closed = showUnprovenContentDialog([appended], deps);
    click('tab-1', 'show-diff');

    overlay()!.querySelector<HTMLButtonElement>('.modal-footer .modal-btn-primary')!.click();
    await vi.runAllTimersAsync();
    await closed;

    expect(diffs[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it('renders a tab filename as text, not markup', () => {
    void showUnprovenContentDialog([{ ...appended, filename: '<img src=x onerror=alert(1)>' }], fakeDeps().deps);

    expect(overlay()!.querySelector('img')).toBeNull();
    expect(row('tab-1').querySelector('.unproven-summary')!.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
