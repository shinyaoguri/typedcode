// @vitest-environment happy-dom
/**
 * テンプレート取込のダイアログの状態契約 (data-dialog) のテスト (#434)。
 * E2E はこの名前で確認ダイアログと進捗の開閉を読む (翻訳テキストや inline style に依存しない)。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ParsedTemplate } from '@typedcode/shared';
import { TemplateImportDialog } from '../TemplateImportDialog.js';

const template: ParsedTemplate = {
  version: '1.0',
  metadata: { name: 'sample' },
  files: [{ filename: 'main.c', language: 'c', content: 'int main(void) { return 0; }\n' }],
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('TemplateImportDialog state contract', () => {
  it('opens the confirmation as data-dialog="template-import" and removes it once confirmed', async () => {
    const result = new TemplateImportDialog().showConfirmation(template, true);
    expect(document.querySelectorAll('[data-dialog="template-import"]')).toHaveLength(1);
    document.querySelector<HTMLElement>('#template-confirm-btn')!.click();
    await expect(result).resolves.toBe(true);
    expect(document.querySelector('[data-dialog="template-import"]')).toBeNull();
  });

  it('opens the progress overlay as data-dialog="template-progress" and removes it on close', () => {
    const progress = new TemplateImportDialog().showProgress();
    expect(document.querySelectorAll('[data-dialog="template-progress"]')).toHaveLength(1);
    progress.close();
    expect(document.querySelector('[data-dialog="template-progress"]')).toBeNull();
  });
});

function pressKey(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
}

const keydownBalance = (add: { mock: { calls: unknown[][] } }, remove: { mock: { calls: unknown[][] } }): number => {
  const count = (spy: { mock: { calls: unknown[][] } }): number =>
    spy.mock.calls.filter((c) => c[0] === 'keydown').length;
  return count(add) - count(remove);
};

describe('TemplateImportDialog accessibility', () => {
  const confirmModal = (): HTMLElement => document.querySelector<HTMLElement>('.template-import-modal')!;
  const progressModal = (): HTMLElement => document.querySelector<HTMLElement>('.template-progress-modal')!;
  const confirmBtn = (): HTMLElement => document.getElementById('template-confirm-btn')!;
  const cancelBtn = (): HTMLElement => document.getElementById('template-cancel-btn')!;

  it('exposes role=dialog and aria-modal=true on the confirmation and names it by its heading', () => {
    void new TemplateImportDialog().showConfirmation(template, false);
    expect(confirmModal().getAttribute('role')).toBe('dialog');
    expect(confirmModal().getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(confirmModal().getAttribute('aria-labelledby')!)?.tagName).toBe('H3');
  });

  it('starts on confirm when no tab exists, and on cancel when the import would affect existing tabs', () => {
    void new TemplateImportDialog().showConfirmation(template, false);
    expect(document.activeElement).toBe(confirmBtn());
    document.body.innerHTML = '';
    void new TemplateImportDialog().showConfirmation(template, true);
    expect(document.activeElement).toBe(cancelBtn());
  });

  it('keeps Tab inside the confirmation by wrapping from the last button to the first', () => {
    void new TemplateImportDialog().showConfirmation(template, false);
    confirmBtn().focus();
    const event = pressKey({ key: 'Tab' });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cancelBtn());
  });

  it('cancels on Escape and removes the confirmation', async () => {
    const result = new TemplateImportDialog().showConfirmation(template, true);
    pressKey({ key: 'Escape' });
    await expect(result).resolves.toBe(false);
    expect(document.querySelector('[data-dialog="template-import"]')).toBeNull();
  });

  it('cancels when the overlay is clicked', async () => {
    const result = new TemplateImportDialog().showConfirmation(template, true);
    document.querySelector<HTMLElement>('[data-dialog="template-import"]')!.click();
    await expect(result).resolves.toBe(false);
  });

  it.each(['confirm', 'cancel', 'overlay', 'escape'] as const)(
    'returns focus to the opener when the confirmation is closed via %s',
    async (path) => {
      document.body.innerHTML = '<button id="opener">opener</button>';
      const opener = document.getElementById('opener')!;
      opener.focus();
      const result = new TemplateImportDialog().showConfirmation(template, true);
      if (path === 'escape') pressKey({ key: 'Escape' });
      else if (path === 'overlay') document.querySelector<HTMLElement>('[data-dialog="template-import"]')!.click();
      else (path === 'confirm' ? confirmBtn() : cancelBtn()).click();
      await result;
      expect(document.activeElement).toBe(opener);
    }
  );

  it.each(['confirm', 'cancel', 'overlay', 'escape'] as const)(
    'leaves no document keydown listener behind after repeated open/close of the confirmation via %s',
    (path) => {
      const add = vi.spyOn(document, 'addEventListener');
      const remove = vi.spyOn(document, 'removeEventListener');
      for (let i = 0; i < 5; i++) {
        void new TemplateImportDialog().showConfirmation(template, false);
        if (path === 'escape') pressKey({ key: 'Escape' });
        else if (path === 'overlay') document.querySelector<HTMLElement>('[data-dialog="template-import"]')!.click();
        else (path === 'confirm' ? confirmBtn() : cancelBtn()).click();
      }
      expect(keydownBalance(add, remove)).toBe(0);
      add.mockRestore();
      remove.mockRestore();
    }
  );

  it('exposes role=dialog and aria-modal=true on the progress overlay and holds focus on the dialog itself', () => {
    new TemplateImportDialog().showProgress();
    expect(progressModal().getAttribute('role')).toBe('dialog');
    expect(progressModal().getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(progressModal().getAttribute('aria-labelledby')!)?.tagName).toBe('H3');
    expect(document.activeElement).toBe(progressModal());
  });

  it('does not close the progress overlay on Escape', () => {
    new TemplateImportDialog().showProgress();
    const event = pressKey({ key: 'Escape' });
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector('[data-dialog="template-progress"]')).not.toBeNull();
  });

  it('releases the listener and returns focus to the opener when progress closes, and tolerates a second close', () => {
    document.body.innerHTML = '<button id="opener">opener</button>';
    const opener = document.getElementById('opener')!;
    opener.focus();
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const progress = new TemplateImportDialog().showProgress();
    progress.close();
    progress.close();
    expect(document.querySelector('[data-dialog="template-progress"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(keydownBalance(add, remove)).toBe(0);
    add.mockRestore();
    remove.mockRestore();
  });
});
