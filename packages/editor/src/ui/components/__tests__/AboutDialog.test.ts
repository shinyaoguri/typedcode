// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { I18nInstance } from '@typedcode/shared';
import { showAboutDialog } from '../AboutDialog.js';

const i18n = {
  t: (key: string) => key,
  getLocale: () => 'en',
} as unknown as I18nInstance;

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

type ClosePath = 'button' | 'overlay' | 'escape';

function closeVia(path: ClosePath): void {
  if (path === 'button') document.querySelector<HTMLElement>('.modal-close-btn')!.click();
  else if (path === 'overlay') document.querySelector<HTMLElement>('.modal-overlay')!.click();
  else pressEscape();
  vi.advanceTimersByTime(250);
}

describe('showAboutDialog accessibility', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="settings-btn">settings</button>';
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('exposes role=dialog and aria-modal=true and is named by the app name heading', () => {
    showAboutDialog(i18n);
    const dialog = document.querySelector<HTMLElement>('.modal-about')!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('TypedCode');
  });

  it('moves initial focus to the close button', () => {
    showAboutDialog(i18n);
    expect(document.activeElement).toBe(document.querySelector('.modal-close-btn'));
  });

  it.each<ClosePath>(['button', 'overlay', 'escape'])(
    'removes the dialog and returns focus to the opener when closed via %s',
    (path) => {
      const opener = document.getElementById('settings-btn')!;
      opener.focus();
      showAboutDialog(i18n);
      closeVia(path);
      expect(document.querySelector('.modal-overlay')).toBeNull();
      expect(document.activeElement).toBe(opener);
    }
  );

  it('returns focus to returnFocusTo rather than the element focused at open time', () => {
    const menuItem = document.createElement('button');
    document.body.appendChild(menuItem);
    menuItem.focus();
    const toggle = document.getElementById('settings-btn')!;
    showAboutDialog(i18n, { returnFocusTo: toggle });
    closeVia('button');
    expect(document.activeElement).toBe(toggle);
  });

  it.each<ClosePath>(['button', 'overlay', 'escape'])(
    'leaves no document keydown listener behind after repeated open/close via %s',
    (path) => {
      const add = vi.spyOn(document, 'addEventListener');
      const remove = vi.spyOn(document, 'removeEventListener');
      for (let i = 0; i < 5; i++) {
        showAboutDialog(i18n);
        closeVia(path);
      }
      const count = (spy: typeof add): number => spy.mock.calls.filter((c) => c[0] === 'keydown').length;
      expect(count(add) - count(remove)).toBe(0);
      add.mockRestore();
      remove.mockRestore();
    }
  );
});
