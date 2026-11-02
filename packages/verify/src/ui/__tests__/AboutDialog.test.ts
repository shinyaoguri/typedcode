// @vitest-environment happy-dom
/**
 * About ダイアログの閉じ方 (#408)。
 *
 * Escape 用の keydown リスナーは document に付く。以前は Escape で閉じたときしか外れず、
 * 閉じるボタン / overlay クリックで閉じるたびに document にリスナーが溜まっていた。
 * どの経路で閉じても追加と削除が釣り合うことを固定する。
 */

import type { I18nInstance } from '@typedcode/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { showAboutDialog } from '../AboutDialog.js';

const i18n = {
  t: (key: string) => key,
  getLocale: () => 'ja',
} as unknown as I18nInstance;

function overlay(): HTMLElement | null {
  return document.querySelector('.modal-overlay');
}

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
}

/** spy 越しに、`keydown` リスナーとして渡された関数を取り出す */
function keydownListeners(spy: { mock: { calls: unknown[][] } }): unknown[] {
  return spy.mock.calls.filter((call) => call[0] === 'keydown').map((call) => call[1]);
}

let addSpy: ReturnType<typeof vi.spyOn>;
let removeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  addSpy = vi.spyOn(document, 'addEventListener');
  removeSpy = vi.spyOn(document, 'removeEventListener');
});

afterEach(() => {
  // 開いたままのテストが次のテストへ document のリスナーを持ち越さないよう閉じておく
  pressEscape();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('showAboutDialog: closing', () => {
  it('removes the keydown listener when closed with the close button', () => {
    showAboutDialog(i18n);
    expect(keydownListeners(addSpy)).toHaveLength(1);

    (document.querySelector('.modal-close-btn') as HTMLElement).click();
    vi.advanceTimersByTime(200);

    expect(overlay()).toBeNull();
    // 追加したのと同じ関数が外されている
    expect(keydownListeners(removeSpy)).toEqual(keydownListeners(addSpy));

    // 閉じた後の Escape は何も起こさない (リスナー自体が無い)
    removeSpy.mockClear();
    pressEscape();
    expect(keydownListeners(removeSpy)).toHaveLength(0);
  });

  it('removes the keydown listener when closed by clicking the overlay', () => {
    showAboutDialog(i18n);

    overlay()?.click();
    vi.advanceTimersByTime(200);

    expect(overlay()).toBeNull();
    expect(keydownListeners(removeSpy)).toEqual(keydownListeners(addSpy));
  });

  it('keeps the dialog open when the click lands inside the dialog', () => {
    showAboutDialog(i18n);

    (document.querySelector('.modal-dialog') as HTMLElement).click();
    vi.advanceTimersByTime(200);

    expect(overlay()).not.toBeNull();
    expect(keydownListeners(removeSpy)).toHaveLength(0);
  });

  it('still closes on Escape and removes the listener', () => {
    showAboutDialog(i18n);

    pressEscape();
    vi.advanceTimersByTime(200);

    expect(overlay()).toBeNull();
    expect(keydownListeners(removeSpy)).toEqual(keydownListeners(addSpy));
  });

  it('is idempotent: closing twice removes the listener once and leaves no listener behind', () => {
    showAboutDialog(i18n);
    const closeBtn = document.querySelector('.modal-close-btn') as HTMLElement;

    closeBtn.click();
    pressEscape();
    closeBtn.click();
    vi.advanceTimersByTime(200);

    expect(overlay()).toBeNull();
    expect(keydownListeners(removeSpy)).toHaveLength(1);
  });

  it('does not accumulate listeners over repeated open/close cycles', () => {
    for (let i = 0; i < 3; i++) {
      showAboutDialog(i18n);
      (document.querySelector('.modal-close-btn') as HTMLElement).click();
      vi.advanceTimersByTime(200);
    }

    expect(keydownListeners(addSpy)).toHaveLength(3);
    expect(keydownListeners(removeSpy)).toHaveLength(3);
  });
});
