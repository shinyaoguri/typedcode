// @vitest-environment happy-dom
/**
 * 復元時に証明と食い違った元のコードの通知 (#413 の受け入れ条件 1・3)。イベント列の飛びで記録を
 * 切り詰めたタブ (#878) も同じ通知で知らせ、理由を行と説明の段落の `data-reason` に出す。
 *
 * 差分の表示 (Monaco) とダウンロードは依存として差し替え、状態契約 (data-*) で確かめる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getI18n } from '../../../i18n/index.js';
import { en } from '../../../i18n/translations/en.js';
import { ja } from '../../../i18n/translations/ja.js';
import type { RestoreDivergence } from '../../tabs/TabManager.js';
import { showUnprovenContentDialog, type UnprovenContentDialogDeps } from '../UnprovenContentDialog.js';

const appended: RestoreDivergence = {
  tabId: 'tab-1',
  filename: 'main',
  language: 'c',
  original: 'int x;PENDING',
  chainContent: 'int x;',
  reason: 'pending-events',
};

const deleted: RestoreDivergence = {
  tabId: 'tab-2',
  filename: 'util',
  language: 'python',
  original: 'ac',
  chainContent: 'abc',
  reason: 'pending-events',
};

/** 保存済みのイベント列の飛びで記録を切り詰めたタブ (#878) */
const truncated: RestoreDivergence = {
  tabId: 'tab-3',
  filename: 'gap',
  language: 'c',
  original: 'int a;int b;',
  chainContent: 'int a;',
  reason: 'sequence-gap',
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
    getI18n().setLocale('ja');
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

  it('marks each row with why its original code was kept', () => {
    void showUnprovenContentDialog([appended, truncated], fakeDeps().deps);

    expect([...overlay()!.querySelectorAll<HTMLElement>('.unproven-item')].map((r) => r.dataset.reason)).toEqual([
      'pending-events',
      'sequence-gap',
    ]);
  });

  it('explains only the reasons present in this notice', () => {
    void showUnprovenContentDialog([truncated], fakeDeps().deps);

    const messages = [...overlay()!.querySelectorAll<HTMLElement>('.unproven-message')];
    expect(messages.map((m) => m.dataset.reason)).toEqual(['sequence-gap']);
  });

  it.each([
    ['ja', ja.unprovenContent.messageSequenceGap],
    ['en', en.unprovenContent.messageSequenceGap],
  ] as const)('explains a truncated record in the %s locale', (locale, expected) => {
    getI18n().setLocale(locale);

    void showUnprovenContentDialog([truncated], fakeDeps().deps);

    expect(overlay()!.querySelector<HTMLElement>('.unproven-message[data-reason="sequence-gap"]')!.textContent).toBe(
      expected
    );
  });
});
