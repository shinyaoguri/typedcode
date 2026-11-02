// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportProgressDialog } from '../ExportProgressDialog.js';

function pressKey(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
}

const dialogEl = (): HTMLElement => document.querySelector<HTMLElement>('.export-progress-modal')!;

describe('ExportProgressDialog accessibility', () => {
  beforeEach(() => {
    document.body.innerHTML = '<button id="opener">opener</button>';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('exposes role=dialog and aria-modal=true and is named by its title heading', () => {
    new ExportProgressDialog().show();
    const dialog = dialogEl();
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.tagName).toBe('H3');
  });

  it('holds focus on the dialog itself while nothing inside is operable', () => {
    new ExportProgressDialog().show();
    expect(document.activeElement).toBe(dialogEl());
  });

  it('keeps focus on the dialog when Tab is pressed instead of letting it reach the page behind', () => {
    document.getElementById('opener')!.focus();
    new ExportProgressDialog().show();
    const event = pressKey({ key: 'Tab' });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialogEl());
  });

  it('does not close on Escape because the export cannot be dismissed', () => {
    const dialog = new ExportProgressDialog();
    dialog.show();
    const event = pressKey({ key: 'Escape' });
    expect(event.defaultPrevented).toBe(false);
    expect(dialog.isVisible()).toBe(true);
    expect(document.querySelector('[data-dialog="export-progress"]')).not.toBeNull();
  });

  it('returns focus to the opener when hidden', () => {
    const opener = document.getElementById('opener')!;
    opener.focus();
    const dialog = new ExportProgressDialog();
    dialog.show();
    dialog.hide();
    expect(document.querySelector('[data-dialog="export-progress"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('leaves no document keydown listener behind after repeated show/hide', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const dialog = new ExportProgressDialog();
    for (let i = 0; i < 5; i++) {
      dialog.show();
      dialog.show(); // 表示中の 2 回目は何もしない
      dialog.hide();
      dialog.hide();
    }
    const count = (spy: typeof add): number => spy.mock.calls.filter((c) => c[0] === 'keydown').length;
    expect(count(add) - count(remove)).toBe(0);
    add.mockRestore();
    remove.mockRestore();
  });
});
