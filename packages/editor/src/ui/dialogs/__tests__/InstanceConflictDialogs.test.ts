// @vitest-environment happy-dom
/**
 * 競合の画面 (#237 PR-3)。読み取り専用になったタブに、DOM の画面で競合を知らせ (本番では console が消える)、
 * その時点のコードの救出ボタンを出す。状態契約は `data-dialog="instance-conflict"` と `data-action`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../../i18n/index.js';
import { showInstanceConflictOverlay } from '../InstanceConflictDialogs.js';

describe('showInstanceConflictOverlay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  const overlay = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-dialog="instance-conflict"]');
  const button = (action: string): HTMLElement =>
    document.querySelector<HTMLElement>(`[data-dialog="instance-conflict"] [data-action="${action}"]`)!;

  it('shows an open instance-conflict screen in the DOM that tells the user this tab was resumed elsewhere', () => {
    showInstanceConflictOverlay({ onRescue: vi.fn(), onClose: vi.fn() });

    expect(overlay()).not.toBeNull();
    expect(overlay()!.classList.contains('hidden')).toBe(false);
    expect(overlay()!.textContent).toContain(t('instanceConflict.title'));
  });

  it('runs the rescue and keeps the screen open so the code can be rescued again', async () => {
    const onRescue = vi.fn();
    showInstanceConflictOverlay({ onRescue, onClose: vi.fn() });

    button('rescue').click();
    await vi.runAllTimersAsync();
    button('rescue').click();
    await vi.runAllTimersAsync();

    expect(onRescue).toHaveBeenCalledTimes(2);
    expect(overlay()?.classList.contains('hidden')).toBe(false);
  });

  it('closes the tab from the close button', async () => {
    const onClose = vi.fn();
    showInstanceConflictOverlay({ onRescue: vi.fn(), onClose });

    button('close').click();
    await vi.runAllTimersAsync();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('replaces an already shown screen instead of stacking a second one', () => {
    showInstanceConflictOverlay({ onRescue: vi.fn(), onClose: vi.fn() });
    showInstanceConflictOverlay({ onRescue: vi.fn(), onClose: vi.fn() });

    expect(document.querySelectorAll('[data-dialog="instance-conflict"]')).toHaveLength(1);
  });
});
