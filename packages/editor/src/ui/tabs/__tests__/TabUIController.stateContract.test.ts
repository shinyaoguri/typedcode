// @vitest-environment happy-dom
/**
 * TabUIController が出すタブの状態契約 (`.editor-tab` の data-*) のテスト (#433)。
 * E2E (`packages/e2e/tests/helpers/app.ts` の `tabs()` / `expectConsistent()`) はこの属性だけを読むので、
 * class `active` や表示テキストとは独立に、値そのものを固定する。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VerificationState } from '@typedcode/shared';
import type { TabManager, TabState } from '../TabManager.js';
import { TabUIController, tabFullFilename } from '../TabUIController.js';

interface FakeTab {
  id: string;
  filename: string;
  language: string;
  verificationState: VerificationState;
}

/**
 * TabUIController が触る TabManager の面だけを持つ代役。renameTab は名前を書き換えるだけで
 * onTabUpdate → updateUI を呼ばない (描き直しに頼らず finishEdit 自身が契約を更新することを見るため)。
 */
function fakeTabManager(tabs: FakeTab[], activeId: string | null): TabManager {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  return {
    getAllTabs: () => tabs,
    getActiveTab: () => (activeId ? (byId.get(activeId) ?? null) : null),
    getTab: (id: string) => byId.get(id) ?? null,
    renameTab: (id: string, name: string) => {
      const tab = byId.get(id);
      if (!tab) return false;
      tab.filename = name;
      return true;
    },
  } as unknown as TabManager;
}

function tab(id: string, overrides: Partial<FakeTab> = {}): FakeTab {
  return { id, filename: `file-${id}`, language: 'c', verificationState: 'skipped', ...overrides };
}

function render(tabs: FakeTab[], activeId: string | null): HTMLElement {
  const container = document.getElementById('editor-tabs')!;
  new TabUIController({ container, tabManager: fakeTabManager(tabs, activeId), basePath: '/' }).updateUI();
  return container;
}

function tabEls(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.editor-tab')];
}

describe('TabUIController state contract', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="editor-tabs"><button class="add-tab-btn"></button></div>';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('marks exactly the active tab with data-active="true" and every other tab with "false"', () => {
    const container = render([tab('a'), tab('b'), tab('c')], 'b');

    expect(tabEls(container).map((el) => [el.dataset.tabId, el.dataset.active])).toEqual([
      ['a', 'false'],
      ['b', 'true'],
      ['c', 'false'],
    ]);
  });

  it('marks no tab as active when the manager has no active tab', () => {
    const container = render([tab('a'), tab('b')], null);

    expect(tabEls(container).map((el) => el.dataset.active)).toEqual(['false', 'false']);
  });

  it('exposes the full filename including the language extension and the raw language id', () => {
    const container = render(
      [tab('a', { filename: 'main', language: 'python' }), tab('b', { filename: 'Untitled-2', language: 'cpp' })],
      'a'
    );

    expect(tabEls(container).map((el) => [el.dataset.filename, el.dataset.language])).toEqual([
      ['main.py', 'python'],
      ['Untitled-2.cpp', 'cpp'],
    ]);
  });

  it('exposes the raw verification state of each tab as data-verification', () => {
    const states: VerificationState[] = ['pending', 'verified', 'failed', 'skipped'];
    const container = render(
      states.map((verificationState, i) => tab(String(i), { verificationState })),
      '0'
    );

    expect(tabEls(container).map((el) => el.dataset.verification)).toEqual(states);
  });

  it('updates data-filename on rename confirmation without relying on a re-render', () => {
    const tabs = [tab('a', { filename: 'old', language: 'javascript' })];
    const container = document.getElementById('editor-tabs')!;
    const controller = new TabUIController({ container, tabManager: fakeTabManager(tabs, 'a'), basePath: '/' });
    controller.updateUI();
    const tabEl = tabEls(container)[0]!;

    controller.startFilenameEdit(tabEl, 'a');
    const input = tabEl.querySelector<HTMLInputElement>('.tab-filename-input')!;
    input.value = 'renamed';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

    expect(tabEl.dataset.filename).toBe('renamed.js');
  });
});

describe('tabFullFilename', () => {
  it('falls back to the txt extension for a language without a registered extension', () => {
    expect(tabFullFilename({ filename: 'notes', language: 'no-such-language' } as TabState)).toBe('notes.txt');
  });
});
