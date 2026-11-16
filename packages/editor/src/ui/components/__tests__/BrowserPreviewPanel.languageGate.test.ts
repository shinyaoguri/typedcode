// @vitest-environment happy-dom
/**
 * HTML プレビュー開始の境界の許可言語 (#727) と `#browser-preview[data-preview-state]` の状態契約。
 * 保存状態の復元や直接の状態変更で html になったタブでも、許可されない言語ならプレビューを描かない。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserPreviewPanel } from '../BrowserPreviewPanel.js';
import type { TabManager, TabState } from '../../tabs/TabManager.js';

function tab(id: string, language: string, content: string): TabState {
  const model = { getValue: () => content, onDidChangeContent: () => ({ dispose: () => {} }) };
  return { id, filename: id, language, model } as unknown as TabState;
}

function fakeTabManager(tabs: TabState[], activeId: string): TabManager {
  return {
    getAllTabs: () => tabs,
    getActiveTab: () => tabs.find((t) => t.id === activeId) ?? null,
  } as unknown as TabManager;
}

beforeEach(() => {
  document.body.innerHTML = `
    <div class="editor-container" id="ec"></div>
    <div id="browser-preview">
      <span id="preview-filename"></span>
      <div id="preview-placeholder"></div>
      <iframe id="preview-iframe"></iframe>
    </div>`;
});

afterEach(() => {
  document.body.innerHTML = '';
});

function open(tabs: TabState[], activeId: string, isTabLanguageAllowed?: (t: TabState) => boolean): HTMLElement {
  const panel = new BrowserPreviewPanel();
  panel.initialize({
    panelId: 'browser-preview',
    toggleButtonId: 'none',
    closeButtonId: 'none',
    refreshButtonId: 'none',
    resizeHandleId: 'none',
    editorContainer: document.getElementById('ec')!,
    getTabManager: () => fakeTabManager(tabs, activeId),
    ...(isTabLanguageAllowed ? { isTabLanguageAllowed } : {}),
  });
  panel.show();
  return document.getElementById('browser-preview')!;
}

function iframe(): HTMLIFrameElement {
  return document.getElementById('preview-iframe') as HTMLIFrameElement;
}

describe('BrowserPreviewPanel language gate (#727)', () => {
  it('does not render an HTML tab whose language is not allowed', () => {
    const el = open([tab('a', 'html', '<p>x</p>')], 'a', () => false);
    expect([el.dataset.previewState, iframe().hasAttribute('srcdoc')]).toEqual(['not-allowed', false]);
  });

  it('renders an HTML tab whose language is allowed', () => {
    const el = open([tab('a', 'html', '<p>x</p>')], 'a', () => true);
    expect([el.dataset.previewState, iframe().getAttribute('srcdoc')?.startsWith('<p>x</p>')]).toEqual([
      'rendered',
      true,
    ]);
  });

  it('reports empty when there is no HTML tab at all', () => {
    const el = open([tab('a', 'c', 'int x;')], 'a', () => false);
    expect(el.dataset.previewState).toBe('empty');
  });

  it('renders HTML tabs without a gate (casual / class)', () => {
    const el = open([tab('a', 'html', '<p>x</p>')], 'a');
    expect(el.dataset.previewState).toBe('rendered');
  });
});
