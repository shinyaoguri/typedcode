// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { showCountdownDialog, showLockOverlay, showModal, type ModalOptions } from '../Modal.js';

/** document に Escape を送る (ダイアログ側のリスナーは document に付く)。 */
function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

function overlayEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.modal-overlay');
}

function buttons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.modal-footer button')];
}

/** showModal を開き、解決回数を数える。 */
function open(options: Partial<ModalOptions> = {}): { resolved: () => number } {
  let count = 0;
  void showModal({ title: 'Title', content: '<p>body</p>', ...options }).then(() => {
    count++;
  });
  return { resolved: () => count };
}

/** closeModal は 200ms 後に DOM から外して resolve する。 */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(250);
}

type ClosePath = 'button' | 'overlay' | 'escape';

async function closeVia(path: ClosePath): Promise<void> {
  if (path === 'button') buttons()[0]!.click();
  else if (path === 'overlay') overlayEl()!.click();
  else pressEscape();
  await settle();
}

type CallSpy = { mock: { calls: unknown[][] } };

/** keydown の addEventListener - removeEventListener。0 なら解放漏れが無い。 */
function keydownBalance(add: CallSpy, remove: CallSpy): number {
  const count = (spy: CallSpy): number => spy.mock.calls.filter((call) => call[0] === 'keydown').length;
  return count(add) - count(remove);
}

describe('showModal accessibility', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="opener">open</button>';
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('exposes role=dialog, aria-modal=true and an aria-labelledby that points at the title', () => {
    open({ title: 'Heading' });
    const dialog = document.querySelector<HTMLElement>('.modal-dialog')!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId!)?.textContent).toBe('Heading');
  });

  it('gives two open dialogs distinct title ids', () => {
    open({ title: 'A' });
    open({ title: 'B' });
    const ids = [...document.querySelectorAll('.modal-dialog')].map((d) => d.getAttribute('aria-labelledby'));
    expect(new Set(ids).size).toBe(2);
  });

  it('moves focus into the dialog on open', () => {
    document.getElementById('opener')!.focus();
    open();
    const dialog = document.querySelector('.modal-dialog')!;
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('puts initial focus on Cancel rather than the destructive action when a danger button exists', () => {
    open({
      buttons: [
        { text: 'Delete', type: 'danger' },
        { text: 'Cancel', type: 'cancel' },
      ],
    });
    expect((document.activeElement as HTMLElement).textContent).toBe('Cancel');
  });

  it.each<ClosePath>(['button', 'overlay', 'escape'])(
    'returns focus to the opener when closed via %s',
    async (path) => {
      const opener = document.getElementById('opener')!;
      opener.focus();
      open();
      await closeVia(path);
      expect(document.activeElement).toBe(opener);
    }
  );

  it('does not leave focus inside the removed dialog when the opener is gone', async () => {
    const opener = document.getElementById('opener')!;
    opener.focus();
    open();
    opener.remove();
    await closeVia('button');
    expect(document.activeElement).toBe(document.body);
  });

  it.each<ClosePath>(['button', 'overlay', 'escape'])(
    'leaves no document keydown listener behind after repeated open/close via %s',
    async (path) => {
      const add = vi.spyOn(document, 'addEventListener');
      const remove = vi.spyOn(document, 'removeEventListener');
      for (let i = 0; i < 5; i++) {
        open();
        await closeVia(path);
      }
      expect(keydownBalance(add, remove)).toBe(0);
      add.mockRestore();
      remove.mockRestore();
    }
  );

  it('handles Escape only for the dialog that is open now, after dialogs closed through every path', async () => {
    for (const path of ['button', 'overlay', 'escape'] as const) {
      for (let i = 0; i < 3; i++) {
        open();
        await closeVia(path);
      }
    }
    const last = open();
    pressEscape();
    await settle();
    expect(last.resolved()).toBe(1);
    expect(overlayEl()).toBeNull();
  });

  it('closes only the topmost dialog on Escape when two are open', async () => {
    const first = open({ title: 'first' });
    const second = open({ title: 'second' });
    pressEscape();
    await settle();
    expect(second.resolved()).toBe(1);
    expect(first.resolved()).toBe(0);
    expect(document.querySelectorAll('.modal-overlay')).toHaveLength(1);
  });

  it('runs an async onClick and resolves once even when the button is clicked again and Escape is pressed meanwhile', async () => {
    const onClick = vi.fn(() => new Promise<boolean>((r) => setTimeout(() => r(true), 100)));
    const modal = open({ buttons: [{ text: 'Go', type: 'primary', onClick }] });
    const btn = buttons()[0]!;
    btn.click();
    expect(btn.disabled).toBe(true);
    btn.click();
    pressEscape();
    overlayEl()!.click();
    await vi.advanceTimersByTimeAsync(50);
    // onClick が終わるまでは、Escape・overlay クリックで閉じ始めない
    expect(overlayEl()!.classList.contains('hidden')).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    await settle();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(modal.resolved()).toBe(1);
    expect(overlayEl()).toBeNull();
  });

  it('schedules the removal only once when closing is requested twice in the same tick', () => {
    open();
    overlayEl()!.click();
    overlayEl()!.click();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('keeps the dialog open and re-enables its buttons when onClick returns false', async () => {
    const onClick = vi.fn(async () => false as const);
    const modal = open({ buttons: [{ text: 'Go', type: 'primary', onClick }] });
    buttons()[0]!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(buttons()[0]!.disabled).toBe(false);
    await settle();
    expect(overlayEl()).not.toBeNull();
    expect(modal.resolved()).toBe(0);
  });

  it('does not close on Escape when closeOnOverlayClick is false', async () => {
    const modal = open({ closeOnOverlayClick: false });
    pressEscape();
    await settle();
    expect(modal.resolved()).toBe(0);
    expect(overlayEl()).not.toBeNull();
  });

  it('closes on Escape when closeOnEscape is true even though closeOnOverlayClick is false', async () => {
    const modal = open({ closeOnOverlayClick: false, closeOnEscape: true });
    pressEscape();
    await settle();
    expect(modal.resolved()).toBe(1);
  });
});

/** 状態契約 (#433): 「開いている」= `[data-dialog]` が DOM にあって `.hidden` が付いていない */
function openDialogNames(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-dialog]')]
    .filter((el) => !el.classList.contains('hidden'))
    .map((el) => el.dataset.dialog!);
}

describe('dialog state contract', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('reports a showModal dialog as open by its dialogName until it is closed', async () => {
    open({ dialogName: 'sample' });
    expect(openDialogNames()).toEqual(['sample']);

    buttons()[0]!.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(openDialogNames()).toEqual([]);
  });

  it('puts the dialogName of countdown dialogs and lock overlays on their overlay', () => {
    void showCountdownDialog({
      title: 'T',
      message: 'M',
      seconds: 30,
      continueButtonText: 'Go',
      dialogName: 'countdown',
    });
    showLockOverlay({
      overlayId: 'lock',
      title: 'T',
      description: 'D',
      buttonText: 'Go',
      onResume: () => {},
      dialogName: 'lock',
    });

    expect(openDialogNames()).toEqual(['countdown', 'lock']);
  });
});
