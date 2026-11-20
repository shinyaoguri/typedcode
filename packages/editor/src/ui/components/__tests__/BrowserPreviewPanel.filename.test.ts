// @vitest-environment happy-dom
/**
 * HTML プレビューの見出し (`#preview-filename`) は、タブに見える名前 (`tabFullFilename`) と同じ (#831)。
 * `tab.filename` は拡張子なし (`index`) でも拡張子込み (`index.html`。テンプレートの取込や改名で入る) でも
 * 入ってくるので、拡張子を素朴に足すと `index.html.html` になる。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserPreviewPanel } from '../BrowserPreviewPanel.js';
import type { TabManager, TabState } from '../../tabs/TabManager.js';

function htmlTab(filename: string): TabState {
  const model = { getValue: () => '<p>x</p>', onDidChangeContent: () => ({ dispose: () => {} }) };
  return { id: 'a', filename, language: 'html', model } as unknown as TabState;
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

function previewHeading(tab: TabState): string | null {
  const panel = new BrowserPreviewPanel();
  panel.initialize({
    panelId: 'browser-preview',
    toggleButtonId: 'none',
    closeButtonId: 'none',
    refreshButtonId: 'none',
    resizeHandleId: 'none',
    editorContainer: document.getElementById('ec')!,
    getTabManager: () => ({ getAllTabs: () => [tab], getActiveTab: () => tab }) as unknown as TabManager,
  });
  panel.show();
  return document.getElementById('preview-filename')!.textContent;
}

describe('BrowserPreviewPanel heading (#831)', () => {
  it('shows a filename that already ends in .html without appending another .html', () => {
    expect(previewHeading(htmlTab('index.html'))).toBe('index.html');
  });

  it('appends .html to a filename stored without an extension', () => {
    expect(previewHeading(htmlTab('index'))).toBe('index.html');
  });
});
