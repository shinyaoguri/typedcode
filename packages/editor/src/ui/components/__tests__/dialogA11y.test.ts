// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachDialogA11y, type DialogA11yHandle } from '../dialogA11y.js';

function key(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
}

/** 開いたダイアログ (タイトル + 2 ボタン) を body に置き、ヘルパを付ける。 */
function mount(overrides: Partial<Parameters<typeof attachDialogA11y>[1]> = {}): {
  dialog: HTMLElement;
  title: HTMLElement;
  a: HTMLButtonElement;
  b: HTMLButtonElement;
  handle: DialogA11yHandle;
  onRequestClose: ReturnType<typeof vi.fn>;
} {
  const dialog = document.createElement('div');
  dialog.innerHTML = '<h3>Title</h3><button id="a">A</button><button id="b">B</button>';
  document.body.appendChild(dialog);
  const title = dialog.querySelector('h3')!;
  const a = dialog.querySelector<HTMLButtonElement>('#a')!;
  const b = dialog.querySelector<HTMLButtonElement>('#b')!;
  const onRequestClose = vi.fn();
  const handle = attachDialogA11y(dialog, { labelledBy: title, onRequestClose, ...overrides });
  return { dialog, title, a, b, handle, onRequestClose };
}

describe('attachDialogA11y', () => {
  beforeEach(() => {
    document.body.innerHTML = '<button id="opener">open</button>';
    document.getElementById('opener')!.focus();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('assigns an id to the labelling element when it has none and points aria-labelledby at it', () => {
    const { dialog, title } = mount();
    expect(title.id).not.toBe('');
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
  });

  it('keeps an existing id on the labelling element', () => {
    const dialog = document.createElement('div');
    dialog.innerHTML = '<h3 id="mine">T</h3><button>x</button>';
    document.body.appendChild(dialog);
    attachDialogA11y(dialog, { labelledBy: dialog.querySelector('h3')!, onRequestClose: vi.fn() });
    expect(dialog.getAttribute('aria-labelledby')).toBe('mine');
  });

  it('focuses the first focusable element on open by default', () => {
    const { a } = mount();
    expect(document.activeElement).toBe(a);
  });

  it('focuses initialFocus on open when given', () => {
    const dialog = document.createElement('div');
    dialog.innerHTML = '<h3>T</h3><button id="x">x</button><button id="y">y</button>';
    document.body.appendChild(dialog);
    attachDialogA11y(dialog, {
      labelledBy: dialog.querySelector('h3')!,
      initialFocus: dialog.querySelector<HTMLElement>('#y'),
      onRequestClose: vi.fn(),
    });
    expect(document.activeElement?.id).toBe('y');
  });

  it('focuses the dialog itself when it has no focusable element', () => {
    const dialog = document.createElement('div');
    dialog.innerHTML = '<h3>T</h3><p>only text</p>';
    document.body.appendChild(dialog);
    attachDialogA11y(dialog, { labelledBy: dialog.querySelector('h3')!, onRequestClose: vi.fn() });
    expect(document.activeElement).toBe(dialog);
  });

  it('wraps Tab from the last focusable element to the first', () => {
    const { a, b } = mount();
    b.focus();
    const event = key({ key: 'Tab' });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(a);
  });

  it('wraps Shift+Tab from the first focusable element to the last', () => {
    const { a, b } = mount();
    a.focus();
    const event = key({ key: 'Tab', shiftKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(b);
  });

  it('leaves Tab between the first and last elements to the browser', () => {
    const { a } = mount();
    a.focus();
    const event = key({ key: 'Tab' });
    expect(event.defaultPrevented).toBe(false);
  });

  it('pulls focus back into the dialog when it is outside and Tab is pressed', () => {
    const { a, b } = mount();
    document.getElementById('opener')!.focus();
    key({ key: 'Tab' });
    expect(document.activeElement).toBe(a);
    document.getElementById('opener')!.focus();
    key({ key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(b);
  });

  it('keeps focus on the dialog when Tab is pressed and nothing inside is focusable', () => {
    const dialog = document.createElement('div');
    dialog.innerHTML = '<h3>T</h3>';
    document.body.appendChild(dialog);
    attachDialogA11y(dialog, { labelledBy: dialog.querySelector('h3')!, onRequestClose: vi.fn() });
    const event = key({ key: 'Tab' });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog);
  });

  it('excludes disabled buttons from the Tab ring', () => {
    const { a, b } = mount();
    b.disabled = true;
    a.focus();
    const event = key({ key: 'Tab' });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(a);
  });

  it('excludes elements inside a hidden subtree from the Tab ring', () => {
    const { dialog, a, b } = mount();
    const wrapper = document.createElement('div');
    wrapper.hidden = true;
    wrapper.innerHTML = '<button id="ghost">g</button>';
    dialog.appendChild(wrapper);
    b.focus();
    key({ key: 'Tab' });
    expect(document.activeElement).toBe(a);
  });

  it('requests close on Escape unless closeOnEscape is false', () => {
    const open = mount();
    key({ key: 'Escape' });
    expect(open.onRequestClose).toHaveBeenCalledTimes(1);
    open.handle.close();

    const locked = mount({ closeOnEscape: false });
    key({ key: 'Escape' });
    expect(locked.onRequestClose).not.toHaveBeenCalled();
  });

  it('routes keys only to the most recently opened dialog', () => {
    const lower = mount();
    const upper = mount();
    key({ key: 'Escape' });
    expect(upper.onRequestClose).toHaveBeenCalledTimes(1);
    expect(lower.onRequestClose).not.toHaveBeenCalled();
    upper.handle.close();
    key({ key: 'Escape' });
    expect(lower.onRequestClose).toHaveBeenCalledTimes(1);
  });

  it('removes its keydown listener on close and treats a second close as a no-op', () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    const { handle, onRequestClose } = mount();
    handle.close();
    handle.close();
    expect(remove.mock.calls.filter((c) => c[0] === 'keydown')).toHaveLength(1);
    key({ key: 'Escape' });
    expect(onRequestClose).not.toHaveBeenCalled();
    remove.mockRestore();
  });

  it('returns focus to the opener on close', () => {
    const { handle } = mount();
    handle.close();
    expect(document.activeElement?.id).toBe('opener');
  });

  it('returns focus to returnFocusTo instead of the element focused at open time', () => {
    const target = document.createElement('button');
    document.body.appendChild(target);
    const { handle } = mount({ returnFocusTo: target });
    handle.close();
    expect(document.activeElement).toBe(target);
  });

  it('moves focus to fallbackFocus when the opener has been removed', () => {
    const fallback = document.createElement('button');
    fallback.id = 'fallback';
    document.body.appendChild(fallback);
    const { handle } = mount({ fallbackFocus: fallback });
    document.getElementById('opener')!.remove();
    handle.close();
    expect(document.activeElement).toBe(fallback);
  });

  it('uses fallbackFocus when the opener refuses focus', () => {
    const fallback = document.createElement('button');
    document.body.appendChild(fallback);
    const { handle } = mount({ fallbackFocus: fallback });
    vi.spyOn(document.getElementById('opener')!, 'focus').mockImplementation(() => undefined);
    handle.close();
    expect(document.activeElement).toBe(fallback);
  });

  it('does not leave focus inside the dialog when neither opener nor fallback is usable', () => {
    const { dialog, handle } = mount();
    document.getElementById('opener')!.remove();
    handle.close();
    expect(dialog.contains(document.activeElement)).toBe(false);
  });
});
