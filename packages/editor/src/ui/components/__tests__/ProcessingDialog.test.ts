// @vitest-environment happy-dom
/**
 * ProcessingDialog (`index.html` の静的 overlay `#processing-dialog`) の a11y (#305)。
 *
 * - 開くと名前付きの modal dialog になり、キャンセルへフォーカスが移る
 * - Escape では閉じない (従来どおり。中止はキャンセルボタン)
 * - 完了・キャンセルのどちらで閉じても、起点へフォーカスが戻り、interval と keydown リスナーが残らない
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../i18n/index.js', () => ({ t: (key: string) => key }));

const { ProcessingDialog } = await import('../ProcessingDialog.js');

const HTML = `
  <button id="opener">export</button>
  <div id="processing-dialog" class="modal-overlay hidden" data-dialog="processing">
    <div class="modal-dialog modal-info">
      <div class="modal-header"><h3>Generating hash chain</h3></div>
      <div class="modal-body">
        <div id="processing-progress-bar"></div>
        <p id="processing-status"></p>
      </div>
      <div class="modal-footer"><button id="processing-cancel-btn">cancel</button></div>
    </div>
  </div>`;

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const overlay = (): HTMLElement => $('processing-dialog');
const isOpen = (): boolean => !overlay().classList.contains('hidden');

function key(k: string): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}

describe('ProcessingDialog a11y', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = HTML;
    $('opener').focus();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('opens as a named modal dialog with focus on the cancel button', () => {
    const dialog = new ProcessingDialog();
    void dialog.waitForComplete(() => ({ pendingCount: 3 }));
    const inner = overlay().querySelector<HTMLElement>('.modal-dialog')!;
    expect(isOpen()).toBe(true);
    expect(inner.getAttribute('role')).toBe('dialog');
    expect(inner.getAttribute('aria-modal')).toBe('true');
    expect($(inner.getAttribute('aria-labelledby')!).textContent).toBe('Generating hash chain');
    expect(document.activeElement).toBe($('processing-cancel-btn'));
    dialog.forceClose();
  });

  it('ignores Escape while waiting', async () => {
    const dialog = new ProcessingDialog();
    let settled = false;
    void dialog
      .waitForComplete(() => ({ pendingCount: 3 }))
      .then(() => {
        settled = true;
      });
    key('Escape');
    await vi.advanceTimersByTimeAsync(300);
    expect(isOpen()).toBe(true);
    expect(settled).toBe(false);
    dialog.forceClose();
  });

  it.each([
    [
      'completion',
      (_: InstanceType<typeof ProcessingDialog>, stats: { pendingCount: number }) => (stats.pendingCount = 0),
    ],
    ['the cancel button', () => $('processing-cancel-btn').click()],
  ])('closes on %s, returns focus to the opener and leaves no interval or keydown listener', async (_, finish) => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const dialog = new ProcessingDialog();
    const stats = { pendingCount: 2 };
    const result = dialog.waitForComplete(() => stats);
    finish(dialog, stats);
    await vi.advanceTimersByTimeAsync(100);
    await result;

    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe($('opener'));
    expect(vi.getTimerCount()).toBe(0);
    const count = (spy: typeof add) => spy.mock.calls.filter((c) => c[0] === 'keydown').length;
    expect(count(add)).toBe(1);
    expect(count(remove)).toBe(1);
  });

  it('does not open when nothing is pending', async () => {
    const dialog = new ProcessingDialog();
    await expect(dialog.waitForComplete(() => ({ pendingCount: 0 }))).resolves.toBe(true);
    expect(isOpen()).toBe(false);
    expect(overlay().querySelector('.modal-dialog')!.hasAttribute('role')).toBe(false);
  });
});
