// @vitest-environment happy-dom
/**
 * サイドバー (`.file-item`) とタブ (`.tab`) の状態契約 (verify/CLAUDE.md「状態契約 (data-* 属性)」)。
 *
 * status の出所は VerificationController の 1 か所 (tabManager.updateTab と同じ値を Sidebar /
 * TabBar に流す) で、Sidebar / TabBar は受け取った値をそのまま data-status に出すだけ。
 * ここでは実物の Sidebar / TabBar / VerifyTabManager を VerificationController につないで、
 * 3 者が同じ status を持つことを固定する (緑のサイドバーと赤いタブ、のような食い違いを防ぐ)。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar, type FileStatus } from '../Sidebar.js';
import { TabBar } from '../TabBar.js';
import { VerifyTabManager } from '../../state/VerifyTabManager.js';
import { VerificationController } from '../controllers/VerificationController.js';
import type { VerificationControllerDependencies } from '../controllers/VerificationController.js';
import type { VerificationResultData } from '../../types.js';
import { mountVerifyIndexHtml } from './verifyDom.js';

const ID = 'file-1';
const FILENAME = 'main.c_proof.json';

function fileItem(id = ID): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#file-list .file-item[data-id="${id}"]`);
}

function tab(id = ID): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#tabbar .tab[data-id="${id}"]`);
}

beforeEach(() => {
  mountVerifyIndexHtml();
});

describe('Sidebar file item state contract', () => {
  it.each<FileStatus>(['pending', 'verifying', 'success', 'warning', 'error'])(
    'exposes status %s and the filename as data attributes',
    (status) => {
      const sidebar = new Sidebar({ onFileSelect: () => {}, onAddFile: () => {} });
      sidebar.addFile({ id: ID, filename: FILENAME, status });

      expect(fileItem()?.dataset.status).toBe(status);
      expect(fileItem()?.dataset.filename).toBe(FILENAME);
    }
  );

  it('follows a status change', () => {
    const sidebar = new Sidebar({ onFileSelect: () => {}, onAddFile: () => {} });
    sidebar.addFile({ id: ID, filename: FILENAME, status: 'pending' });

    sidebar.updateFileStatus(ID, 'warning');

    expect(fileItem()?.dataset.status).toBe('warning');
  });
});

describe('TabBar tab state contract', () => {
  it.each<FileStatus>(['pending', 'verifying', 'success', 'warning', 'error'])(
    'exposes status %s and the filename as data attributes',
    (status) => {
      const tabBar = new TabBar({ onTabSelect: () => {}, onTabClose: () => {} });
      tabBar.addTab({ id: ID, filename: FILENAME, status });

      expect(tab()?.dataset.status).toBe(status);
      expect(tab()?.dataset.filename).toBe(FILENAME);
    }
  );

  it('follows a status change', () => {
    const tabBar = new TabBar({ onTabSelect: () => {}, onTabClose: () => {} });
    tabBar.addTab({ id: ID, filename: FILENAME, status: 'verifying' });

    tabBar.updateTabStatus(ID, 'error');

    expect(tab()?.dataset.status).toBe('error');
  });
});

/** 実物の Sidebar / TabBar / VerifyTabManager に、表示以外の依存をスタブでつないだ controller。 */
function wire(): { controller: VerificationController; tabManager: VerifyTabManager } {
  const tabManager = new VerifyTabManager();
  const sidebar = new Sidebar({ onFileSelect: () => {}, onAddFile: () => {} });
  const tabBar = new TabBar({ onTabSelect: () => {}, onTabClose: () => {} });

  tabManager.addTab({
    id: ID,
    filename: FILENAME,
    language: 'c',
    status: 'pending',
    progress: 0,
    proofData: null,
    verificationResult: null,
  });
  sidebar.addFile({ id: ID, filename: FILENAME, status: 'pending' });
  tabBar.addTab({ id: ID, filename: FILENAME, status: 'pending' });
  tabBar.setActiveTab(ID);

  const deps = {
    tabManager,
    sidebar,
    tabBar,
    uiState: { incrementCompleted: vi.fn() },
    statusBar: { setError: vi.fn() },
    resultPanel: { finishProgress: vi.fn(), errorProgress: vi.fn() },
    tabController: { showTabContent: vi.fn(), openTabForFile: vi.fn(), updateVerificationProgressUI: vi.fn() },
  } as unknown as VerificationControllerDependencies;
  return { controller: new VerificationController(deps), tabManager };
}

/** 署名 cp で密にアンカーされ、root もアンカー済みの健全な結果。 */
function healthyResult(overrides: Partial<VerificationResultData> = {}): VerificationResultData {
  return {
    valid: true,
    metadataValid: true,
    chainValid: true,
    isPureTyping: true,
    rootAnchored: true,
    signedCheckpointAnchored: true,
    signedCheckpointValid: true,
    ...overrides,
  };
}

describe('VerificationController as the single source of file status', () => {
  const cases: Array<[FileStatus, Partial<VerificationResultData>]> = [
    ['success', {}],
    ['warning', { poswMode: 'skipped' }],
    ['warning', { isPureTyping: false }],
    ['error', { valid: false, chainValid: false }],
  ];

  it.each(cases)(
    'puts the same %s status on the tab state, the file item and the tab when verification completes',
    (expected, overrides) => {
      const { controller, tabManager } = wire();

      controller.handleComplete(ID, healthyResult(overrides));

      expect(tabManager.getTab(ID)?.status).toBe(expected);
      expect(fileItem()?.dataset.status).toBe(expected);
      expect(tab()?.dataset.status).toBe(expected);
    }
  );

  it('marks the file item and the tab as verifying while progress arrives', () => {
    const { controller } = wire();

    controller.handleProgress(ID, 40);

    expect(fileItem()?.dataset.status).toBe('verifying');
    expect(tab()?.dataset.status).toBe('verifying');
  });

  it('marks the file item and the tab as error when the worker reports an error', () => {
    const { controller, tabManager } = wire();

    controller.handleError(ID, 'boom');

    expect(tabManager.getTab(ID)?.status).toBe('error');
    expect(fileItem()?.dataset.status).toBe('error');
    expect(tab()?.dataset.status).toBe('error');
  });
});
