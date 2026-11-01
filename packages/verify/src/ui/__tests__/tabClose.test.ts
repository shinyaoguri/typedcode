// @vitest-environment happy-dom
/**
 * タブ・ファイルを閉じた後の active / 表示の一致 (#281 v2)。
 *
 * active を持つ場所は TabBar / VerifyTabManager / Sidebar / 結果パネル (UIStateManager の表示中 id) の
 * 4 つ。閉じた後に 1 か所でも食い違うと「選択はタブ B だが結果パネルは閉じたタブ C のまま」になり、
 * 採点者が別の提出物の判定を読む。実物の 7 クラスを AppController と同じ形で結線して固定する。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { TabBar } from '../TabBar.js';
import { Sidebar } from '../Sidebar.js';
import { ResultPanel } from '../ResultPanel.js';
import { WelcomePanel } from '../WelcomePanel.js';
import { TabController } from '../controllers/TabController.js';
import { VerifyTabManager } from '../../state/VerifyTabManager.js';
import { UIStateManager } from '../../state/UIStateManager.js';
import { mountVerifyIndexHtml } from './verifyDom.js';

interface App {
  tabBar: TabBar;
  sidebar: Sidebar;
  tabManager: VerifyTabManager;
  uiState: UIStateManager;
  tabController: TabController;
}

function wire(): App {
  mountVerifyIndexHtml();
  const tabManager = new VerifyTabManager();
  const uiState = new UIStateManager();
  const resultPanel = new ResultPanel();
  const welcomePanel = new WelcomePanel({ onFilesSelected: () => {}, onBrowse: () => {} });
  const holder: { controller?: TabController } = {};
  const tabBar = new TabBar({
    onTabSelect: (id) => holder.controller?.handleTabSelect(id),
    onTabClose: (id) => holder.controller?.handleTabClose(id),
  });
  const sidebar = new Sidebar({ onFileSelect: () => {}, onAddFile: () => {} });
  const tabController = new TabController({
    tabManager,
    uiState,
    tabBar,
    sidebar,
    resultPanel,
    welcomePanel,
    getTimelineChart: () => null,
    getMouseChart: () => null,
  });
  holder.controller = tabController;
  tabManager.setOnChange((tab) => tabController.showTabContent(tab.id));
  return { tabBar, sidebar, tabManager, uiState, tabController };
}

/** プレーンテキストのファイルを tabManager と sidebar に登録する (タブはまだ開かない)。 */
function addFile(app: App, id: string, folderId?: string): void {
  app.tabManager.addTab({
    id,
    filename: `${id}.txt`,
    language: 'plaintext',
    status: 'success',
    progress: 100,
    proofData: null,
    verificationResult: null,
    isPlaintext: true,
    plaintextContent: id,
  });
  app.sidebar.addFile({ id, filename: `${id}.txt`, status: 'success', isProof: false, folderId });
}

function openFiles(app: App, ids: string[]): void {
  for (const id of ids) app.tabController.openTabForFile(id);
}

function closeTab(id: string): void {
  document.querySelector<HTMLElement>(`#tabbar .tab[data-id="${id}"] .tab-close`)!.click();
}

/** 4 か所の active を並べて読む。 */
function actives(app: App): {
  tabBar: string | null;
  tabManager: string | null;
  sidebar: string | null;
  displayed: string | null;
} {
  return {
    tabBar: app.tabBar.getActiveTabId(),
    tabManager: app.tabManager.getActiveTab()?.id ?? null,
    sidebar: app.sidebar.getActiveFileId(),
    displayed: app.uiState.getState().currentDisplayedTabId,
  };
}

function visible(id: string): boolean {
  return document.getElementById(id)!.style.display !== 'none';
}

let app: App;

beforeEach(() => {
  app = wire();
});

describe('closing a tab', () => {
  it('moves the TabBar, VerifyTabManager, Sidebar and result panel together when the active tab is closed', () => {
    for (const id of ['a', 'b', 'c']) addFile(app, id);
    openFiles(app, ['a', 'b', 'c']);
    expect(actives(app)).toEqual({ tabBar: 'c', tabManager: 'c', sidebar: 'c', displayed: 'c' });

    closeTab('c');

    const next = app.tabBar.getActiveTabId();
    expect(next).not.toBeNull();
    expect(next).not.toBe('c');
    expect(actives(app)).toEqual({ tabBar: next, tabManager: next, sidebar: next, displayed: next });
    // 閉じたタブのファイルはサイドバーに残る (タブを閉じてもファイル一覧には残す)
    expect(app.sidebar.getFileCount()).toBe(3);
  });

  it('leaves the active tab alone when an inactive tab is closed', () => {
    for (const id of ['a', 'b', 'c']) addFile(app, id);
    openFiles(app, ['a', 'b', 'c']);

    closeTab('b');

    expect(actives(app)).toEqual({ tabBar: 'c', tabManager: 'c', sidebar: 'c', displayed: 'c' });
  });

  it('shows the welcome panel and hides the result when the last tab is closed', () => {
    addFile(app, 'a');
    openFiles(app, ['a']);

    closeTab('a');

    expect(visible('welcome-panel')).toBe(true);
    expect(visible('result-container')).toBe(false);
  });

  it('clears the Sidebar and VerifyTabManager active when the last tab is closed', () => {
    addFile(app, 'a');
    openFiles(app, ['a']);

    closeTab('a');

    expect(app.sidebar.getActiveFileId()).toBeNull();
    expect(app.tabManager.getActiveTab()).toBeNull();
    // ファイル自体は一覧に残る
    expect(app.sidebar.getFileCount()).toBe(1);
    expect(app.tabManager.hasTab('a')).toBe(true);
    expect(document.querySelector('#file-list .file-item[data-active="true"]')).toBeNull();
  });
});

describe('removing files from the sidebar', () => {
  it('never selects a file that has no open tab when the active file is removed', () => {
    for (const id of ['a', 'x', 'c']) addFile(app, id);
    // x はサイドバーと tabManager にはあるが、タブは開いていない
    openFiles(app, ['a', 'c']);

    app.tabController.removeFile('c');

    expect(actives(app)).toEqual({ tabBar: 'a', tabManager: 'a', sidebar: 'a', displayed: 'a' });
    expect(app.sidebar.getFileCount()).toBe(2);
  });

  it('moves every active together when the active file of a folder is removed with the folder', () => {
    app.sidebar.addFolder({ id: 'f', name: 'folder', expanded: true });
    addFile(app, 'a');
    addFile(app, 'c', 'f');
    addFile(app, 'd', 'f');
    openFiles(app, ['a', 'c']);

    app.tabController.removeFolder('f');

    expect(actives(app)).toEqual({ tabBar: 'a', tabManager: 'a', sidebar: 'a', displayed: 'a' });
    expect(app.sidebar.getFileCount()).toBe(1);
    expect(app.sidebar.getFolderCount()).toBe(0);
    expect(app.tabManager.hasTab('c')).toBe(false);
    expect(app.tabManager.hasTab('d')).toBe(false);
  });

  it('shows the welcome panel when the last open file is removed', () => {
    addFile(app, 'a');
    openFiles(app, ['a']);

    app.tabController.removeFile('a');

    expect(visible('welcome-panel')).toBe(true);
    expect(visible('result-container')).toBe(false);
  });
});

describe('removing a nested folder', () => {
  it('forgets the tabs of files in descendant folders, not only the direct children', () => {
    app.sidebar.addFolder({ id: 'f1', name: 'one', expanded: true });
    app.sidebar.addFolder({ id: 'f2', name: 'two', expanded: true, parentId: 'f1' });
    app.sidebar.addFolder({ id: 'f3', name: 'three', expanded: true, parentId: 'f2' });
    addFile(app, 'a');
    addFile(app, 'b', 'f1');
    addFile(app, 'c', 'f2');
    addFile(app, 'd', 'f3');
    openFiles(app, ['a', 'b', 'c', 'd']);

    app.tabController.removeFolder('f1');

    expect(document.querySelectorAll('#tabbar .tab')).toHaveLength(1);
    for (const id of ['b', 'c', 'd']) {
      expect(app.tabBar.hasTab(id)).toBe(false);
      expect(app.tabManager.hasTab(id)).toBe(false);
      expect(document.querySelector(`#tabbar .tab[data-id="${id}"]`)).toBeNull();
    }
    expect(actives(app)).toEqual({ tabBar: 'a', tabManager: 'a', sidebar: 'a', displayed: 'a' });
    expect(app.sidebar.getFileCount()).toBe(1);
    expect(app.sidebar.getFolderCount()).toBe(0);
  });
});

describe('Sidebar.getFilesInFolder', () => {
  it('returns only the direct children, leaving descendants to getFileIdsInFolderTree', () => {
    app.sidebar.addFolder({ id: 'f1', name: 'one', expanded: true });
    app.sidebar.addFolder({ id: 'f2', name: 'two', expanded: true, parentId: 'f1' });
    addFile(app, 'b', 'f1');
    addFile(app, 'c', 'f2');

    expect(app.sidebar.getFilesInFolder('f1')).toEqual(['b']);
    expect(app.sidebar.getFileIdsInFolderTree('f1').sort()).toEqual(['b', 'c']);
  });
});

describe('Sidebar.removeFolder', () => {
  it('forgets the active file when the folder holding it is removed', () => {
    app.sidebar.addFolder({ id: 'f', name: 'folder', expanded: true });
    addFile(app, 'c', 'f');
    app.sidebar.setActiveFile('c');

    app.sidebar.removeFolder('f');

    expect(app.sidebar.getActiveFileId()).toBeNull();
  });
});

describe('active state contract (data-active)', () => {
  function activeIds(selector: string): string[] {
    return Array.from(document.querySelectorAll<HTMLElement>(`${selector}[data-active="true"]`)).map(
      (el) => el.dataset.id ?? '?'
    );
  }

  it('marks exactly the active tab and file item, and nothing else, with data-active', () => {
    for (const id of ['a', 'b', 'c']) addFile(app, id);
    openFiles(app, ['a', 'b', 'c']);

    expect(activeIds('#tabbar .tab')).toEqual(['c']);
    expect(activeIds('#file-list .file-item')).toEqual(['c']);
    // 非アクティブには属性自体を付けない ("false" も付けない)
    expect(document.querySelector('#tabbar .tab[data-id="a"]')?.hasAttribute('data-active')).toBe(false);
    expect(document.querySelector('#file-list .file-item[data-id="a"]')?.hasAttribute('data-active')).toBe(false);
  });

  it('follows the active tab after the active tab is closed', () => {
    for (const id of ['a', 'b', 'c']) addFile(app, id);
    openFiles(app, ['a', 'b', 'c']);

    closeTab('c');

    expect(activeIds('#tabbar .tab')).toEqual(['a']);
    expect(activeIds('#file-list .file-item')).toEqual(['a']);
  });
});
