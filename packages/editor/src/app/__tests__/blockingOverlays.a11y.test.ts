// @vitest-environment happy-dom
/**
 * 起動を止める静的 overlay (`duplicate-instance` / `unsupported-browser` / `boot-failure`) の a11y (#305)。
 *
 * どれも閉じる経路を持たない (このページはここで止まる) ので、Escape では閉じない。
 * 名前付きの modal dialog にし、唯一の操作 (無ければダイアログ自身) へフォーカスを移し、Tab を閉じ込める。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { showBootFailure } from '../bootFailure.js';
import { showDuplicateInstanceOverlay, showUnsupportedBrowserOverlay } from '../../services/SingleInstanceGuard.js';

const HTML = `
  <button id="background">background</button>
  <div id="duplicate-instance-overlay" class="modal-overlay hidden" data-dialog="duplicate-instance">
    <div class="modal-dialog modal-info">
      <div class="modal-header"><h3>Already running</h3></div>
      <div class="modal-footer"><button id="duplicate-instance-close-btn">close this tab</button></div>
    </div>
  </div>
  <div id="boot-failure-overlay" class="modal-overlay hidden" data-dialog="boot-failure">
    <div class="modal-dialog modal-danger">
      <div class="modal-header"><h3>Could not start</h3></div>
      <div class="modal-body">
        <p id="boot-failure-blocked-hint" hidden></p>
        <details><summary id="boot-failure-summary">detail</summary><pre id="boot-failure-detail-text"></pre></details>
      </div>
      <div class="modal-footer"><button id="boot-failure-reload-btn">reload</button></div>
    </div>
  </div>
  <div id="unsupported-browser-overlay" class="modal-overlay hidden" data-dialog="unsupported-browser">
    <div class="modal-dialog modal-warning">
      <div class="modal-header"><h3>Unsupported browser</h3></div>
      <div class="modal-body"><p>Use Chrome or Edge.</p></div>
    </div>
  </div>`;

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const inner = (overlayId: string): HTMLElement => $(overlayId).querySelector<HTMLElement>('.modal-dialog')!;

function key(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
}

function expectNamedModal(overlayId: string, name: string): void {
  const dialog = inner(overlayId);
  expect($(overlayId).classList.contains('hidden')).toBe(false);
  expect(dialog.getAttribute('role')).toBe('dialog');
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect($(dialog.getAttribute('aria-labelledby')!).textContent).toBe(name);
}

describe('blocking overlays a11y', () => {
  beforeEach(() => {
    document.body.innerHTML = HTML;
    $('background').focus();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    // 閉じる経路が無いので keydown リスナーはケースを跨いで残る。最前面だけが処理するので次のケースに干渉しない
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('shows the duplicate-instance overlay as a named modal with focus on its only action, ignoring Escape', () => {
    showDuplicateInstanceOverlay();
    expectNamedModal('duplicate-instance-overlay', 'Already running');
    expect(document.activeElement).toBe($('duplicate-instance-close-btn'));
    $('background').focus();
    key({ key: 'Tab' });
    expect(document.activeElement).toBe($('duplicate-instance-close-btn'));
    key({ key: 'Escape' });
    expect($('duplicate-instance-overlay').classList.contains('hidden')).toBe(false);
  });

  it('shows the unsupported-browser overlay as a named modal that holds focus on itself', () => {
    showUnsupportedBrowserOverlay();
    expectNamedModal('unsupported-browser-overlay', 'Unsupported browser');
    expect(document.activeElement).toBe(inner('unsupported-browser-overlay'));
    const event = key({ key: 'Tab' });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(inner('unsupported-browser-overlay'));
    key({ key: 'Escape' });
    expect($('unsupported-browser-overlay').classList.contains('hidden')).toBe(false);
  });

  it('shows the boot-failure overlay as a named modal with focus on reload and keeps Tab between its controls', () => {
    showBootFailure(new Error('boom'));
    expectNamedModal('boot-failure-overlay', 'Could not start');
    expect(document.activeElement).toBe($('boot-failure-reload-btn'));
    key({ key: 'Tab' });
    expect(document.activeElement).toBe($('boot-failure-summary'));
    key({ key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe($('boot-failure-reload-btn'));
    key({ key: 'Escape' });
    expect($('boot-failure-overlay').classList.contains('hidden')).toBe(false);
  });

  it('attaches the boot-failure dialog once even when reported twice', () => {
    const add = vi.spyOn(document, 'addEventListener');
    showBootFailure(new Error('first'));
    showBootFailure(new Error('second'));
    expect(add.mock.calls.filter((c) => c[0] === 'keydown')).toHaveLength(1);
    expect($('boot-failure-detail-text').textContent).toBe('Error: second');
  });
});
