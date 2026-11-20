// @vitest-environment happy-dom
/**
 * TabUIController が出すタブの状態契約 (`.editor-tab` の data-*) のテスト (#433)。
 * E2E (`packages/e2e/tests/helpers/app.ts` の `tabs()` / `expectConsistent()`) はこの属性だけを読むので、
 * class `active` や表示テキストとは独立に、値そのものを固定する。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VerificationState } from '@typedcode/shared';
import type { TabManager, TabState } from '../TabManager.js';
import { TabUIController, tabDisplayParts, tabFullFilename } from '../TabUIController.js';

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

/** タブに見える文字 (`.tab-filename` + `.tab-extension`) */
function visibleName(tabEl: HTMLElement): string {
  return `${tabEl.querySelector('.tab-filename')?.textContent ?? ''}${tabEl.querySelector('.tab-extension')?.textContent ?? ''}`;
}

function extensionSpan(tabEl: HTMLElement): HTMLElement {
  return tabEl.querySelector<HTMLElement>('.tab-extension')!;
}

describe('TabUIController visible tab name (#828)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="editor-tabs"><button class="add-tab-btn"></button></div>';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders visible text that equals data-filename whether or not the stored name carries the extension', () => {
    const container = render(
      [
        tab('a', { filename: 'p1.c', language: 'c' }),
        tab('b', { filename: 'Untitled-1', language: 'c' }),
        tab('c', { filename: 'a.py', language: 'c' }),
      ],
      'a'
    );

    const els = tabEls(container);
    expect(els.map(visibleName)).toEqual(['p1.c', 'Untitled-1.c', 'a.py.c']);
    for (const el of els) expect(visibleName(el)).toBe(el.dataset.filename);
  });

  /** 拡張子込みの名前 (p1.c) のタブで改名を始め、入力欄に `value` を入れて `key` で終える */
  function editExtensionfulTab(value: string, key: 'Enter' | 'Escape') {
    const tabs = [tab('a', { filename: 'p1.c', language: 'c' })];
    const container = document.getElementById('editor-tabs')!;
    const controller = new TabUIController({ container, tabManager: fakeTabManager(tabs, 'a'), basePath: '/' });
    controller.updateUI();
    const tabEl = tabEls(container)[0]!;
    controller.startFilenameEdit(tabEl, 'a');
    const input = tabEl.querySelector<HTMLInputElement>('.tab-filename-input')!;
    const duringEdit = { value: input.value, extensionDisplay: extensionSpan(tabEl).style.display };
    input.value = value;
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    return { tabEl, duringEdit };
  }

  it('hides the extension span while editing a name that already carries the extension and restores it on confirm', () => {
    const { tabEl, duringEdit } = editExtensionfulTab('q.c', 'Enter');

    expect(duringEdit).toEqual({ value: 'p1.c', extensionDisplay: 'none' });
    expect(tabEl.querySelector('.tab-filename')?.textContent).toBe('q');
    expect(extensionSpan(tabEl).textContent).toBe('.c');
    expect(tabEl.dataset.filename).toBe('q.c');
    expect(extensionSpan(tabEl).style.display).toBe('');
  });

  it('shows the language extension after a rename to a name without one', () => {
    const { tabEl } = editExtensionfulTab('plain', 'Enter');

    expect(tabEl.querySelector('.tab-filename')?.textContent).toBe('plain');
    expect(extensionSpan(tabEl).textContent).toBe('.c');
    expect(tabEl.dataset.filename).toBe('plain.c');
  });

  it('restores the original visible name when the edit is cancelled with Escape', () => {
    const { tabEl } = editExtensionfulTab('ignored.c', 'Escape');

    expect(visibleName(tabEl)).toBe('p1.c');
    expect(tabEl.dataset.filename).toBe('p1.c');
    expect(extensionSpan(tabEl).style.display).toBe('');
  });

  it('keeps the extension span visible while editing a name without the extension', () => {
    const tabs = [tab('a', { filename: 'Untitled-1', language: 'c' })];
    const container = document.getElementById('editor-tabs')!;
    const controller = new TabUIController({ container, tabManager: fakeTabManager(tabs, 'a'), basePath: '/' });
    controller.updateUI();
    const tabEl = tabEls(container)[0]!;

    controller.startFilenameEdit(tabEl, 'a');

    expect(tabEl.querySelector<HTMLInputElement>('.tab-filename-input')!.value).toBe('Untitled-1');
    expect(extensionSpan(tabEl).style.display).toBe('');
  });
});

describe('tabDisplayParts', () => {
  it('splits the name and the language extension so that the stored extension is not repeated', () => {
    expect(tabDisplayParts({ filename: 'p1', language: 'c' })).toEqual({ name: 'p1', extension: '.c' });
    expect(tabDisplayParts({ filename: 'p1.c', language: 'c' })).toEqual({ name: 'p1', extension: '.c' });
    expect(tabDisplayParts({ filename: 'main.py', language: 'python' })).toEqual({ name: 'main', extension: '.py' });
    expect(tabDisplayParts({ filename: 'a.py', language: 'c' })).toEqual({ name: 'a.py', extension: '.c' });
    expect(tabDisplayParts({ filename: 'notes', language: 'no-such-language' })).toEqual({
      name: 'notes',
      extension: '.txt',
    });
  });

  it('joins back into tabFullFilename for every input', () => {
    const inputs = [
      { filename: 'p1', language: 'c' },
      { filename: 'p1.c', language: 'c' },
      { filename: 'main.py', language: 'python' },
      { filename: 'a.py', language: 'c' },
      { filename: 'v1.2', language: 'c' },
      { filename: 'notes', language: 'no-such-language' },
    ];
    for (const input of inputs) {
      const { name, extension } = tabDisplayParts(input);
      expect(name + extension).toBe(tabFullFilename(input as TabState));
    }
  });
});

describe('tabFullFilename', () => {
  // #441: class / テンプレート / exam の starter は拡張子込みの名前 (p1.c) で createTab する。
  it('appends exactly one extension whether or not the stored name already carries it', () => {
    expect(tabFullFilename({ filename: 'p1', language: 'c' } as TabState)).toBe('p1.c');
    expect(tabFullFilename({ filename: 'p1.c', language: 'c' } as TabState)).toBe('p1.c');
    expect(tabFullFilename({ filename: 'main.py', language: 'python' } as TabState)).toBe('main.py');
  });

  it('still appends the language extension when the dotted suffix belongs to a different extension', () => {
    expect(tabFullFilename({ filename: 'a.py', language: 'c' } as TabState)).toBe('a.py.c');
    expect(tabFullFilename({ filename: 'v1.2', language: 'c' } as TabState)).toBe('v1.2.c');
  });

  it('falls back to the txt extension for a language without a registered extension', () => {
    expect(tabFullFilename({ filename: 'notes', language: 'no-such-language' } as TabState)).toBe('notes.txt');
  });
});
