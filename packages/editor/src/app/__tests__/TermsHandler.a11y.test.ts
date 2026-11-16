// @vitest-environment happy-dom
/**
 * 利用規約モーダル (`index.html` の静的 overlay `#terms-modal`) の a11y (#305)。
 *
 * - 開くと名前付きの modal dialog になり、最初のアコーディオン (`summary`) へフォーカスが移る
 * - 同意が必須なので Escape では閉じない
 * - 同意で閉じると keydown リスナーが残らず、フォーカスがダイアログ内に残らない
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { showTermsModal } from '../TermsHandler.js';

const HTML = `
  <div id="terms-modal" class="modal-overlay hidden" data-dialog="terms">
    <div class="modal-dialog modal-terms">
      <div class="modal-header"><h3>Terms of Service</h3></div>
      <div class="modal-body">
        <details><summary id="first-summary">Logs</summary><p>...</p></details>
        <details><summary>Hash chain</summary><p>...</p></details>
        <label><input type="checkbox" id="terms-agree-checkbox"> agree</label>
      </div>
      <div class="modal-footer"><button id="terms-agree-btn" disabled>start</button></div>
    </div>
  </div>`;

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const overlay = (): HTMLElement => $('terms-modal');
const isOpen = (): boolean => !overlay().classList.contains('hidden');

function key(init: KeyboardEventInit): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

describe('terms modal a11y', () => {
  beforeEach(() => {
    document.body.innerHTML = HTML;
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('opens as a named modal dialog with focus on the first accordion toggle', () => {
    void showTermsModal();
    const dialog = overlay().querySelector<HTMLElement>('.modal-dialog')!;
    expect(isOpen()).toBe(true);
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect($(dialog.getAttribute('aria-labelledby')!).textContent).toBe('Terms of Service');
    expect(document.activeElement).toBe($('first-summary'));
  });

  it('wraps Shift+Tab from the first accordion toggle to the last control and stays open on Escape', () => {
    void showTermsModal();
    const checkbox = $('terms-agree-checkbox') as HTMLInputElement;
    // 同意ボタンは disabled の間は巡回の外。最後はチェックボックス
    key({ key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(checkbox);
    key({ key: 'Escape' });
    expect(isOpen()).toBe(true);
  });

  it('closes on agreement and releases its keydown listener', async () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const done = showTermsModal();
    const checkbox = $('terms-agree-checkbox') as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    $('terms-agree-btn').click();
    await done;

    expect(isOpen()).toBe(false);
    expect(overlay().contains(document.activeElement)).toBe(false);
    const count = (spy: typeof add) => spy.mock.calls.filter((c) => c[0] === 'keydown').length;
    expect(count(add)).toBe(1);
    expect(count(remove)).toBe(1);
  });
});
