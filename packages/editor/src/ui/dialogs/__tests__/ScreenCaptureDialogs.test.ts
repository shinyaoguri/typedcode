// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { showScreenShareChoiceDialog, showScreenShareOptOutConfirmDialog } from '../ScreenCaptureDialogs.js';

function pressKey(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
}

type Spy = { mock: { calls: unknown[][] } };

/** document に付いた keydown リスナーの収支 (add - remove)。0 なら残っていない */
function keydownBalance(add: Spy, remove: Spy): number {
  const count = (spy: Spy): number => spy.mock.calls.filter((c) => c[0] === 'keydown').length;
  return count(add) - count(remove);
}

describe('screen capture dialogs accessibility', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="opener">opener</button>';
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  describe('showScreenShareChoiceDialog', () => {
    const dialogEl = (): HTMLElement => document.querySelector<HTMLElement>('.screen-share-choice-dialog')!;
    const choiceBtn = (choice: string): HTMLElement =>
      document.querySelector<HTMLElement>(`[data-choice="${choice}"]`)!;

    it('exposes role=dialog and aria-modal=true and is named by its title heading', () => {
      void showScreenShareChoiceDialog();
      expect(dialogEl().getAttribute('role')).toBe('dialog');
      expect(dialogEl().getAttribute('aria-modal')).toBe('true');
      expect(document.getElementById(dialogEl().getAttribute('aria-labelledby')!)?.tagName).toBe('H3');
    });

    it('puts initial focus on the share option', () => {
      void showScreenShareChoiceDialog();
      expect(document.activeElement).toBe(choiceBtn('share'));
    });

    it('keeps Tab inside the dialog by wrapping from the last option to the first', () => {
      void showScreenShareChoiceDialog();
      choiceBtn('optOut').focus();
      const event = pressKey({ key: 'Tab' });
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(choiceBtn('share'));
    });

    it('resolves "cancelled" on Escape and returns focus to the opener', async () => {
      const opener = document.getElementById('opener')!;
      opener.focus();
      const result = showScreenShareChoiceDialog();
      pressKey({ key: 'Escape' });
      vi.advanceTimersByTime(250);
      await expect(result).resolves.toBe('cancelled');
      expect(document.querySelector('[data-dialog="screen-share-choice"]')).toBeNull();
      expect(document.activeElement).toBe(opener);
    });

    it.each(['share', 'optOut'] as const)('resolves %s when that option is clicked', async (choice) => {
      const result = showScreenShareChoiceDialog();
      choiceBtn(choice).click();
      vi.advanceTimersByTime(250);
      await expect(result).resolves.toBe(choice);
    });

    it.each(['click', 'escape'] as const)(
      'leaves no document keydown listener behind after repeated open/close via %s',
      (path) => {
        const add = vi.spyOn(document, 'addEventListener');
        const remove = vi.spyOn(document, 'removeEventListener');
        for (let i = 0; i < 5; i++) {
          void showScreenShareChoiceDialog();
          if (path === 'click') choiceBtn('share').click();
          else pressKey({ key: 'Escape' });
          vi.advanceTimersByTime(250);
        }
        expect(keydownBalance(add, remove)).toBe(0);
        add.mockRestore();
        remove.mockRestore();
      }
    );
  });

  describe('showScreenShareOptOutConfirmDialog', () => {
    const dialogEl = (): HTMLElement => document.querySelector<HTMLElement>('.screen-share-optout-confirm-dialog')!;
    const actionBtn = (action: string): HTMLElement =>
      document.querySelector<HTMLElement>(`[data-action="${action}"]`)!;

    it('exposes role=dialog and aria-modal=true and is named by its title heading', () => {
      void showScreenShareOptOutConfirmDialog();
      expect(dialogEl().getAttribute('role')).toBe('dialog');
      expect(dialogEl().getAttribute('aria-modal')).toBe('true');
      expect(document.getElementById(dialogEl().getAttribute('aria-labelledby')!)?.tagName).toBe('H3');
    });

    it('puts initial focus on cancel, not on the confirm that lowers the proof trust level', () => {
      void showScreenShareOptOutConfirmDialog();
      expect(document.activeElement).toBe(actionBtn('cancel'));
    });

    it('resolves false on Escape and returns focus to the opener', async () => {
      const opener = document.getElementById('opener')!;
      opener.focus();
      const result = showScreenShareOptOutConfirmDialog();
      pressKey({ key: 'Escape' });
      vi.advanceTimersByTime(250);
      await expect(result).resolves.toBe(false);
      expect(document.activeElement).toBe(opener);
    });

    it('resolves true when confirm is clicked', async () => {
      const result = showScreenShareOptOutConfirmDialog();
      actionBtn('confirm').click();
      vi.advanceTimersByTime(250);
      await expect(result).resolves.toBe(true);
    });

    it.each(['confirm', 'cancel', 'escape'] as const)(
      'leaves no document keydown listener behind after repeated open/close via %s',
      (path) => {
        const add = vi.spyOn(document, 'addEventListener');
        const remove = vi.spyOn(document, 'removeEventListener');
        for (let i = 0; i < 5; i++) {
          void showScreenShareOptOutConfirmDialog();
          if (path === 'escape') pressKey({ key: 'Escape' });
          else actionBtn(path).click();
          vi.advanceTimersByTime(250);
        }
        expect(keydownBalance(add, remove)).toBe(0);
        add.mockRestore();
        remove.mockRestore();
      }
    );
  });
});
