// @vitest-environment happy-dom
/**
 * `showCountdownDialog` (アイドルの警告) と `showLockOverlay` (記録停止・画面共有の停止) の a11y (#305)。
 *
 * どちらも閉鎖規則は従来どおり (Escape では閉じない。閉じるのはボタン・時間切れ・呼び出し側の hide)。
 * 名前付きの modal dialog にし、操作ボタンへフォーカスを移し、Tab を閉じ込める。どの経路で閉じても
 * 起点へ戻り、timer と keydown リスナーが残らない (同じ id で出し直したときの前の回も)。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hideLockOverlay, showCountdownDialog, showLockOverlay } from '../Modal.js';

function key(init: KeyboardEventInit): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

const $ = (id: string): HTMLElement => document.getElementById(id)!;

function keydownBalance(): { added: () => number; removed: () => number } {
  const add = vi.spyOn(document, 'addEventListener');
  const remove = vi.spyOn(document, 'removeEventListener');
  const count = (spy: typeof add) => spy.mock.calls.filter((c) => c[0] === 'keydown').length;
  return { added: () => count(add), removed: () => count(remove) };
}

function expectNamedModal(dialog: HTMLElement, name: string): void {
  expect(dialog.getAttribute('role')).toBe('dialog');
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect($(dialog.getAttribute('aria-labelledby')!).textContent).toBe(name);
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<button id="opener">editor</button>';
  $('opener').focus();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('showCountdownDialog a11y', () => {
  function open(seconds = 5): Promise<boolean> {
    return showCountdownDialog({
      title: 'Session warning',
      message: 'm',
      seconds,
      continueButtonText: 'Continue',
      dialogId: 'cd',
      dialogName: 'idle-warning',
    });
  }
  const dialog = (): HTMLElement => document.querySelector<HTMLElement>('#cd .countdown-dialog')!;
  const continueBtn = (): HTMLElement => document.querySelector<HTMLElement>('#cd .countdown-continue-btn')!;

  it('opens as a named modal dialog with focus on the continue button, traps Tab and ignores Escape', () => {
    void open();
    expectNamedModal(dialog(), 'Session warning');
    expect(document.activeElement).toBe(continueBtn());
    $('opener').focus();
    key({ key: 'Tab' });
    expect(document.activeElement).toBe(continueBtn());
    key({ key: 'Escape' });
    expect($('cd').classList.contains('hidden')).toBe(false);
    continueBtn().click(); // 次のケースに開いたまま持ち越さない
  });

  it.each([
    ['the continue button', () => continueBtn().click(), true],
    ['the timeout', () => vi.advanceTimersByTime(2000), false],
  ])('closes via %s, returns focus to the opener and leaves no timer or listener', async (_, finish, expected) => {
    const balance = keydownBalance();
    const result = open(2);
    finish();
    await expect(result).resolves.toBe(expected);
    expect(document.activeElement).toBe($('opener'));
    await vi.advanceTimersByTimeAsync(250);
    expect(vi.getTimerCount()).toBe(0);
    expect(balance.added()).toBe(1);
    expect(balance.removed()).toBe(1);
  });

  it('releases the previous countdown timer and listener when shown again with the same id', async () => {
    const balance = keydownBalance();
    void open(60);
    const second = open(60);
    expect(document.querySelectorAll('#cd')).toHaveLength(1);
    expect(balance.removed()).toBe(1);
    continueBtn().click();
    await expect(second).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(vi.getTimerCount()).toBe(0);
    expect(balance.added()).toBe(balance.removed());
  });
});

describe('showLockOverlay a11y', () => {
  function open(onResume: () => undefined | Promise<boolean | undefined> = () => undefined) {
    return showLockOverlay({
      overlayId: 'lock',
      title: 'Recording paused',
      description: 'd',
      buttonText: 'Resume',
      className: 'idle-suspended-overlay',
      dialogName: 'idle-suspended',
      onResume,
      secondaryButtonText: 'Without',
      onSecondaryAction: () => undefined,
    });
  }
  const content = (): HTMLElement => document.querySelector<HTMLElement>('#lock .idle-suspended-content')!;
  const resumeBtn = (): HTMLElement => document.querySelector<HTMLElement>('#lock .idle-suspended-content-btn')!;
  const secondaryBtn = (): HTMLElement =>
    document.querySelector<HTMLElement>('#lock .idle-suspended-content-btn-secondary')!;

  it('opens as a named modal dialog with focus on the resume button, traps Tab both ways and ignores Escape', () => {
    open();
    expectNamedModal(content(), 'Recording paused');
    expect(document.activeElement).toBe(resumeBtn());
    secondaryBtn().focus();
    key({ key: 'Tab' });
    expect(document.activeElement).toBe(resumeBtn());
    key({ key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(secondaryBtn());
    key({ key: 'Escape' });
    expect($('lock').classList.contains('hidden')).toBe(false);
    hideLockOverlay('lock');
  });

  it('closes after an async resume resolves, returns focus to the opener and releases its listener', async () => {
    const balance = keydownBalance();
    let finish: (v: boolean) => void = () => undefined;
    open(() => new Promise<boolean>((r) => (finish = r)));
    resumeBtn().click();
    expect($('lock').classList.contains('hidden')).toBe(false); // 再開の結果を待っている間は開いたまま
    finish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect($('lock').classList.contains('hidden')).toBe(true);
    expect(document.activeElement).toBe($('opener'));
    expect(balance.removed()).toBe(1);
  });

  it('stays open and keeps trapping focus when the async resume returns false', async () => {
    const balance = keydownBalance();
    open(() => Promise.resolve(false));
    resumeBtn().click();
    await vi.advanceTimersByTimeAsync(0);
    expect($('lock').classList.contains('hidden')).toBe(false);
    expect(balance.removed()).toBe(0);
    $('opener').focus();
    key({ key: 'Tab' });
    expect(content().contains(document.activeElement)).toBe(true);
    hideLockOverlay('lock');
  });

  it('releases its listener and returns focus when hidden by id from outside', () => {
    const balance = keydownBalance();
    open();
    hideLockOverlay('lock');
    expect(document.activeElement).toBe($('opener'));
    expect(balance.removed()).toBe(1);
  });

  it('releases the previous listener when shown again with the same id', () => {
    const balance = keydownBalance();
    open();
    open();
    expect(document.querySelectorAll('#lock')).toHaveLength(1);
    expect(balance.removed()).toBe(1);
    hideLockOverlay('lock');
    expect(balance.added()).toBe(balance.removed());
  });
});
