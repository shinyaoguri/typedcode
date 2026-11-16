// @vitest-environment happy-dom
/**
 * タブを閉じる確認ダイアログ (`index.html` の静的 overlay `#tab-close-dialog`) の a11y (#305)。
 *
 * - 開くと名前付きの modal dialog になり、初期フォーカスは取り消し側 (破壊的な操作)
 * - キャンセル・overlay・Escape で閉じると起点の × へ戻る。開いている間にタブ列が描き直されたら同じタブの新しい × へ
 * - 確定するとタブごと × が消えるので、アクティブなタブの × へ移る
 * - 開閉を繰り返しても document の keydown リスナーが残らない
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabManager } from '../TabManager.js';

vi.mock('../../../i18n/index.js', () => ({ t: (key: string) => key }));

const { TabUIController } = await import('../TabUIController.js');

interface FakeTab {
  id: string;
  filename: string;
  language: string;
  verificationState: 'skipped';
}

const HTML = `
  <div id="editor-tabs"><button class="add-tab-btn">+</button></div>
  <div id="tab-close-dialog" class="modal-overlay hidden" data-dialog="tab-close">
    <div class="modal-dialog modal-danger">
      <div class="modal-header"><h3>Close tab</h3></div>
      <div class="modal-body"><p id="tab-close-filename"></p></div>
      <div class="modal-footer">
        <button id="tab-close-cancel-btn">cancel</button>
        <button id="tab-close-confirm-btn">close</button>
      </div>
    </div>
  </div>`;

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const overlay = (): HTMLElement => $('tab-close-dialog');
const isOpen = (): boolean => !overlay().classList.contains('hidden');
const closeBtnOf = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`.editor-tab[data-tab-id="${id}"] .tab-close-btn`)!;

function key(init: KeyboardEventInit): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

/** closeTab でタブを外し、TabManager と同じく同期にタブ列を描き直す代役。 */
function setup(): { ui: InstanceType<typeof TabUIController>; closeTab: ReturnType<typeof vi.fn> } {
  const tabs: FakeTab[] = ['a', 'b'].map((id) => ({ id, filename: id, language: 'c', verificationState: 'skipped' }));
  let activeId = 'a';
  let ui: InstanceType<typeof TabUIController> | null = null;
  const closeTab = vi.fn((id: string) => {
    tabs.splice(
      tabs.findIndex((t) => t.id === id),
      1
    );
    if (activeId === id) activeId = tabs[0]!.id;
    ui!.updateUI();
    return true;
  });
  const manager = {
    getAllTabs: () => tabs,
    getActiveTab: () => tabs.find((t) => t.id === activeId) ?? null,
    getTab: (id: string) => tabs.find((t) => t.id === id) ?? null,
    closeTab,
  } as unknown as TabManager;
  ui = new TabUIController({ container: $('editor-tabs'), tabManager: manager, basePath: '/' });
  ui.updateUI();
  return { ui, closeTab };
}

function openFor(id: string): void {
  closeBtnOf(id).focus();
  closeBtnOf(id).click();
}

describe('tab close confirmation dialog a11y', () => {
  beforeEach(() => {
    document.body.innerHTML = HTML;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('opens as a named modal dialog with focus on the cancel button', () => {
    setup();
    openFor('b');
    const dialog = overlay().querySelector<HTMLElement>('.modal-dialog')!;
    expect(isOpen()).toBe(true);
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect($(dialog.getAttribute('aria-labelledby')!).textContent).toBe('Close tab');
    expect(document.activeElement).toBe($('tab-close-cancel-btn'));
  });

  it.each([
    ['the cancel button', () => $('tab-close-cancel-btn').click()],
    ['an overlay click', () => overlay().click()],
    ['Escape', () => key({ key: 'Escape' })],
  ])('closes via %s without closing the tab and returns focus to its close button', (_, closeIt) => {
    const { closeTab } = setup();
    openFor('b');
    closeIt();
    expect(isOpen()).toBe(false);
    expect(closeTab).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(closeBtnOf('b'));
  });

  it('returns focus to the redrawn close button of the same tab when the tab strip was rebuilt while open', () => {
    const { ui } = setup();
    openFor('b');
    const stale = closeBtnOf('b');
    ui.updateUI();
    expect(stale.isConnected).toBe(false);
    $('tab-close-cancel-btn').click();
    expect(document.activeElement).toBe(closeBtnOf('b'));
  });

  it('closes the tab on confirm and moves focus to the active tab close button', () => {
    const { closeTab } = setup();
    openFor('a');
    $('tab-close-confirm-btn').click();
    expect(closeTab).toHaveBeenCalledTimes(1);
    expect(closeTab).toHaveBeenCalledWith('a');
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(closeBtnOf('b'));
  });

  it('keeps Tab and Shift+Tab inside the dialog', () => {
    setup();
    openFor('b');
    $('tab-close-confirm-btn').focus();
    key({ key: 'Tab' });
    expect(document.activeElement).toBe($('tab-close-cancel-btn'));
    key({ key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe($('tab-close-confirm-btn'));
  });

  it('leaves no keydown listener behind and runs no stale handler after repeated open and close', () => {
    const { closeTab } = setup();
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    for (let i = 0; i < 3; i++) {
      openFor('b');
      $('tab-close-cancel-btn').click();
      openFor('b');
      overlay().click();
      openFor('b');
      key({ key: 'Escape' });
    }
    const count = (spy: typeof add) => spy.mock.calls.filter((c) => c[0] === 'keydown').length;
    expect(count(add)).toBe(9);
    expect(count(remove)).toBe(9);

    // 前に開いた回の確定ハンドラが残っていれば、ここで closeTab が複数回走る
    openFor('b');
    $('tab-close-confirm-btn').click();
    expect(closeTab).toHaveBeenCalledTimes(1);
  });
});
