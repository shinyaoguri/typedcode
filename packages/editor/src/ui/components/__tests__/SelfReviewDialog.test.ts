// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessSummary } from '@typedcode/shared';
import { SelfReviewDialog } from '../SelfReviewDialog.js';

const summary: ProcessSummary = {
  totalEvents: 100,
  durationMs: 65_000,
  contentChangeCount: 10,
  insertedChars: 120,
  deletedChars: 20,
  deletionRatio: 0.16,
  executionCount: 2,
  hasRunResults: true,
  runSuccessCount: 1,
  runFailureCount: 1,
  pauseCount: 3,
  longestPauseMs: 4000,
  focusLossCount: 0,
  externalInputCount: 0,
  reflectionNotes: [],
  moments: [],
};

function pressKey(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
}

const dialogEl = (): HTMLElement => document.querySelector<HTMLElement>('.self-review-dialog')!;
const action = (name: string): HTMLElement => document.querySelector<HTMLElement>(`[data-action="${name}"]`)!;

describe('SelfReviewDialog accessibility', () => {
  beforeEach(() => {
    document.body.innerHTML = '<button id="opener">opener</button>';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('exposes role=dialog and aria-modal=true and is named by its title heading', () => {
    void new SelfReviewDialog().show(summary);
    const dialog = dialogEl();
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.tagName).toBe('H2');
  });

  it('puts initial focus on the note textarea', () => {
    void new SelfReviewDialog().show(summary);
    expect(document.activeElement).toBe(document.getElementById('self-review-note'));
  });

  it('keeps Tab inside the dialog by wrapping from the last button to the first', () => {
    void new SelfReviewDialog().show(summary);
    action('proceed').focus();
    const event = pressKey({ key: 'Tab' });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('.self-review-close'));
  });

  it('ignores Escape so that a half-written note is not lost with one key', async () => {
    const result = vi.fn();
    void new SelfReviewDialog().show(summary).then(result);
    const note = document.getElementById('self-review-note') as HTMLTextAreaElement;
    note.value = 'draft';
    const event = pressKey({ key: 'Escape' });
    await Promise.resolve();
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector('[data-dialog="self-review"]')).not.toBeNull();
    expect(note.value).toBe('draft');
    expect(result).not.toHaveBeenCalled();
  });

  it('proceeds with the trimmed note when proceed is clicked', async () => {
    const result = new SelfReviewDialog().show(summary);
    (document.getElementById('self-review-note') as HTMLTextAreaElement).value = '  learned loops \n';
    action('proceed').click();
    await expect(result).resolves.toEqual({ proceed: true, note: 'learned loops' });
  });

  it.each(['cancel', 'proceed'] as const)('returns focus to the opener when closed via %s', async (path) => {
    const opener = document.getElementById('opener')!;
    opener.focus();
    const result = new SelfReviewDialog().show(summary);
    action(path).click();
    await result;
    expect(document.activeElement).toBe(opener);
  });

  it.each(['cancel', 'proceed'] as const)(
    'leaves no document keydown listener behind after repeated open/close via %s',
    (path) => {
      const add = vi.spyOn(document, 'addEventListener');
      const remove = vi.spyOn(document, 'removeEventListener');
      const dialog = new SelfReviewDialog();
      for (let i = 0; i < 5; i++) {
        void dialog.show(summary);
        action(path).click();
      }
      const count = (spy: typeof add): number => spy.mock.calls.filter((c) => c[0] === 'keydown').length;
      expect(count(add) - count(remove)).toBe(0);
      add.mockRestore();
      remove.mockRestore();
    }
  );

  it('releases the previous dialog listener when show() is called again on the same instance', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const dialog = new SelfReviewDialog();
    void dialog.show(summary);
    void dialog.show(summary);
    expect(document.querySelectorAll('[data-dialog="self-review"]')).toHaveLength(1);
    const count = (spy: typeof add): number => spy.mock.calls.filter((c) => c[0] === 'keydown').length;
    expect(count(add) - count(remove)).toBe(1);
    add.mockRestore();
    remove.mockRestore();
  });
});
