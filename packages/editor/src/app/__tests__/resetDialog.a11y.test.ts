// @vitest-environment happy-dom
/**
 * リセット確認ダイアログ (`index.html` の静的 overlay) の a11y (#305)。
 *
 * - 開くと名前付きの modal dialog になり、初期フォーカスは取り消し側 (破壊的な操作のダイアログ)
 * - キャンセル・overlay・Escape のどれで閉じても、閉じた設定メニューの項目ではなく設定ボタンへ戻る
 * - 開閉を繰り返しても document の keydown リスナーが残らない
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../i18n/index.js', () => ({ t: (key: string) => key }));

const clearCurrentModeData = vi.fn<() => Promise<void>>(() => new Promise(() => undefined));
vi.mock('../../utils/StorageClearHelper.js', () => ({
  clearCurrentModeData: () => clearCurrentModeData(),
}));
vi.mock('../AppHelpers.js', () => ({ showNotification: vi.fn() }));

const { setupResetDialog } = await import('../resetDialog.js');
const { SettingsDropdown } = await import('../../ui/components/SettingsDropdown.js');

const HTML = `
  <button id="settings-btn" aria-controls="settings-dropdown">settings</button>
  <div id="settings-dropdown" class="visible"><button id="reset-btn">reset</button></div>
  <div id="reset-dialog" class="modal-overlay hidden" data-dialog="reset">
    <div class="modal-dialog modal-danger">
      <div class="modal-header"><h3>Reset this mode</h3></div>
      <div class="modal-body"><p id="reset-scope" data-mode="" data-tab-count=""></p></div>
      <div class="modal-footer">
        <button id="reset-cancel-btn">cancel</button>
        <button id="reset-confirm-btn"><span>confirm</span></button>
      </div>
    </div>
  </div>`;

function key(k: string): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const overlay = (): HTMLElement => $('reset-dialog');
const dialog = (): HTMLElement => overlay().querySelector<HTMLElement>('.modal-dialog')!;
const isOpen = (): boolean => !overlay().classList.contains('hidden');

function open(): void {
  $('reset-btn').focus();
  $('reset-btn').click();
}

describe('reset dialog a11y', () => {
  let ctx: {
    mode: 'casual';
    tabManager: null;
    skipBeforeUnload: boolean;
    settingsDropdown: InstanceType<typeof SettingsDropdown>;
  };

  beforeEach(() => {
    document.body.innerHTML = HTML;
    const settingsDropdown = new SettingsDropdown();
    settingsDropdown.initialize({ buttonId: 'settings-btn', dropdownId: 'settings-dropdown' });
    ctx = { mode: 'casual', tabManager: null, skipBeforeUnload: false, settingsDropdown };
    setupResetDialog(ctx);
  });

  afterEach(() => {
    ctx.settingsDropdown.dispose();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('opens as a named modal dialog with focus on the cancel button', () => {
    open();
    expect(isOpen()).toBe(true);
    expect(dialog().getAttribute('role')).toBe('dialog');
    expect(dialog().getAttribute('aria-modal')).toBe('true');
    expect($(dialog().getAttribute('aria-labelledby')!).textContent).toBe('Reset this mode');
    expect(document.activeElement).toBe($('reset-cancel-btn'));
  });

  it('reports the settings menu as collapsed (aria-expanded="false") once the reset item has closed it', () => {
    expect($('settings-btn').getAttribute('aria-expanded')).toBe('true');
    open();
    expect($('settings-dropdown').classList.contains('visible')).toBe(false);
    expect($('settings-btn').getAttribute('aria-expanded')).toBe('false');
  });

  it.each([
    ['the cancel button', () => $('reset-cancel-btn').click()],
    ['an overlay click', () => overlay().click()],
    ['Escape', () => key('Escape')],
  ])('closes via %s and returns focus to the settings button, not the hidden menu item', (_, closeIt) => {
    open();
    closeIt();
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe($('settings-btn'));
  });

  it('keeps Tab and Shift+Tab inside the dialog', () => {
    open();
    $('reset-confirm-btn').focus();
    key('Tab');
    expect(document.activeElement).toBe($('reset-cancel-btn'));
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    );
    expect(document.activeElement).toBe($('reset-confirm-btn'));
  });

  it('leaves no keydown listener behind after repeated open and close through every route', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    for (let i = 0; i < 3; i++) {
      open();
      $('reset-cancel-btn').click();
      open();
      overlay().click();
      open();
      key('Escape');
    }
    const count = (spy: typeof add, type: string) => spy.mock.calls.filter((c) => c[0] === type).length;
    expect(count(add, 'keydown')).toBe(9);
    expect(count(remove, 'keydown')).toBe(9);

    // 閉じたあとの Escape は何もしない (閉じたダイアログの処理が走らない)
    overlay().classList.remove('hidden');
    key('Escape');
    expect(isOpen()).toBe(true);
  });

  it('closes and starts the reset when the confirm button is pressed', () => {
    open();
    clearCurrentModeData.mockClear();
    $('reset-confirm-btn').querySelector('span')!.click();
    expect(isOpen()).toBe(false);
    expect(ctx.skipBeforeUnload).toBe(true);
    // 確定の委任リスナーは document に付くので、前のケースの配線も反応する。呼ばれたことだけを見る
    expect(clearCurrentModeData).toHaveBeenCalled();
  });
});
