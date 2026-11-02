// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@typedcode/shared';
import { showSessionRecoveryDialog } from '../SessionRecoveryDialog.js';

const summary: SessionSummary = {
  sessionId: 's1',
  createdAt: 1,
  lastActiveAt: Date.now(),
  tabs: [{ id: 't1', filename: 'main.c', language: 'c', eventCount: 12, lastModifiedAt: 1 }],
};

function pressKey(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
}

const dialogEl = (): HTMLElement => document.querySelector<HTMLElement>('.session-recovery-dialog')!;
const resumeBtn = (): HTMLElement => document.getElementById('session-resume-btn')!;
const freshBtn = (): HTMLElement => document.getElementById('session-fresh-btn')!;

describe('showSessionRecoveryDialog accessibility', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="opener">opener</button>';
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('exposes role=dialog and aria-modal=true and is named by its title heading', () => {
    void showSessionRecoveryDialog(summary);
    const dialog = dialogEl();
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(dialog.getAttribute('aria-labelledby')!);
    expect(title?.tagName).toBe('H3');
  });

  it('puts initial focus on the non-destructive resume button, not on start-fresh', () => {
    void showSessionRecoveryDialog(summary);
    expect(document.activeElement).toBe(resumeBtn());
  });

  it('ignores Escape because a choice is required', async () => {
    const result = vi.fn();
    void showSessionRecoveryDialog(summary).then(result);
    const event = pressKey({ key: 'Escape' });
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(event.defaultPrevented).toBe(false);
    expect(document.getElementById('session-recovery-overlay')).not.toBeNull();
    expect(result).not.toHaveBeenCalled();
  });

  it('keeps Tab inside the dialog by wrapping from the last button to the first', () => {
    void showSessionRecoveryDialog(summary);
    resumeBtn().focus(); // フッタの最後のボタン
    const event = pressKey({ key: 'Tab' });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(freshBtn());
  });

  it.each([
    ['resume', resumeBtn],
    ['fresh', freshBtn],
  ] as const)('resolves with %s, removes the dialog and returns focus to the opener', async (choice, button) => {
    const opener = document.getElementById('opener')!;
    opener.focus();
    const result = showSessionRecoveryDialog(summary);
    button().click();
    vi.advanceTimersByTime(1000);
    await expect(result).resolves.toEqual({ choice });
    expect(document.getElementById('session-recovery-overlay')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('leaves no document keydown listener behind after repeated open/close', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    for (let i = 0; i < 5; i++) {
      void showSessionRecoveryDialog(summary);
      (i % 2 === 0 ? resumeBtn() : freshBtn()).click();
      vi.advanceTimersByTime(1000);
    }
    const count = (spy: typeof add): number => spy.mock.calls.filter((c) => c[0] === 'keydown').length;
    expect(count(add) - count(remove)).toBe(0);
    add.mockRestore();
    remove.mockRestore();
  });

  it('releases the previous dialog listener when a new dialog replaces it', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    void showSessionRecoveryDialog(summary);
    void showSessionRecoveryDialog(summary); // 前のダイアログを DOM から外して置き換える
    expect(document.querySelectorAll('#session-recovery-overlay')).toHaveLength(1);
    const count = (spy: typeof add): number => spy.mock.calls.filter((c) => c[0] === 'keydown').length;
    expect(count(add) - count(remove)).toBe(1); // 残るのは表示中の 1 つだけ
    add.mockRestore();
    remove.mockRestore();
  });
});
