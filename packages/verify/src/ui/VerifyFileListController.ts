/**
 * VerifyFileListController - 検証ページのサイドバーファイルリスト制御
 * リサイズ可能なサイドバーでファイル一覧を表示し、検証完了後にのみ選択可能にする
 */

import type { VerifyTabState, VerificationStatus, ProgressDetails } from '../types.js';
import type { VerifyTabManager } from '../state/VerifyTabManager.js';

export interface VerifyFileListControllerOptions {
  listContainer: HTMLElement;
  sidebarContainer: HTMLElement;
  resizeHandle: HTMLElement;
  tabManager: VerifyTabManager;
}

export class VerifyFileListController {
  private listContainer: HTMLElement;
  private sidebarContainer: HTMLElement;
  private resizeHandle: HTMLElement;
  private tabManager: VerifyTabManager;

  // リサイズ状態
  private isResizing = false;
  private startX = 0;
  private startWidth = 0;

  // リサイズ制約
  private readonly MIN_WIDTH = 150;
  private readonly MAX_WIDTH = 400;

  constructor(options: VerifyFileListControllerOptions) {
    this.listContainer = options.listContainer;
    this.sidebarContainer = options.sidebarContainer;
    this.resizeHandle = options.resizeHandle;
    this.tabManager = options.tabManager;

    this.initResizeHandler();
  }

  /**
   * リサイズハンドラを初期化
   */
  private initResizeHandler(): void {
    this.resizeHandle.addEventListener('mousedown', this.onResizeStart.bind(this));
    document.addEventListener('mousemove', this.onResizeMove.bind(this));
    document.addEventListener('mouseup', this.onResizeEnd.bind(this));
  }

  private onResizeStart(e: MouseEvent): void {
    this.isResizing = true;
    this.startX = e.clientX;
    this.startWidth = this.sidebarContainer.offsetWidth;
    this.resizeHandle.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  }

  private onResizeMove(e: MouseEvent): void {
    if (!this.isResizing) return;

    const deltaX = e.clientX - this.startX;
    let newWidth = this.startWidth + deltaX;

    // 制約を適用
    newWidth = Math.max(this.MIN_WIDTH, Math.min(this.MAX_WIDTH, newWidth));

    this.sidebarContainer.style.width = `${newWidth}px`;
  }

  private onResizeEnd(): void {
    if (!this.isResizing) return;

    this.isResizing = false;
    this.resizeHandle.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  /**
   * ファイルが選択可能かどうか判定
   */
  private isSelectable(status: VerificationStatus): boolean {
    return status === 'success' || status === 'warning' || status === 'error';
  }

  /**
   * イベント数を表示するフェーズかどうか
   */
  private isEventCountPhase(phase: string): boolean {
    return phase === 'chain' || phase === 'segment' || phase === 'full';
  }

  /**
   * ファイルリストアイテムを生成
   */
  createFileListItem(tab: VerifyTabState): HTMLElement {
    const itemEl = document.createElement('div');
    itemEl.className = 'verify-file-item';
    itemEl.dataset.id = tab.id;

    const isActive = this.tabManager.getActiveTabId() === tab.id;
    const isDisabled = !this.isSelectable(tab.status);

    if (isActive) {
      itemEl.classList.add('active');
    }
    if (isDisabled) {
      itemEl.classList.add('disabled');
    }

    // ファイル名からパスを除去
    const displayName = tab.filename.split('/').pop() ?? tab.filename;
    // 拡張子を分離
    const lastDotIndex = displayName.lastIndexOf('.');
    const nameWithoutExt = lastDotIndex > 0 ? displayName.substring(0, lastDotIndex) : displayName;
    const ext = lastDotIndex > 0 ? displayName.substring(lastDotIndex) : '';

    // 進捗表示（検証中のみ）
    let progressHtml = '';
    if (tab.status === 'verifying') {
      if (tab.progressDetails && this.isEventCountPhase(tab.progressDetails.phase)) {
        // 詳細表示: 検証済み/総数
        progressHtml = `<span class="file-progress">${tab.progressDetails.current.toLocaleString()}/${tab.progressDetails.total.toLocaleString()}</span>`;
      } else {
        // フォールバック: パーセンテージ
        progressHtml = `<span class="file-progress">${tab.progress}%</span>`;
      }
    }

    itemEl.innerHTML = `
      <span class="file-status-icon ${tab.status}"></span>
      <span class="file-info">
        <span class="file-name">${nameWithoutExt}</span>
        <span class="file-ext">${ext}</span>
      </span>
      ${progressHtml}
    `;

    // クリックイベント（選択可能な場合のみ）
    itemEl.addEventListener('click', () => {
      // クリック時点の最新ステータスを確認
      const currentTab = this.tabManager.getTab(tab.id);
      if (currentTab && this.isSelectable(currentTab.status)) {
        this.tabManager.switchTab(tab.id);
      }
    });

    return itemEl;
  }

  /**
   * UI全体を更新
   */
  updateUI(): void {
    this.listContainer.innerHTML = '';
    for (const tab of this.tabManager.getAllTabs()) {
      const itemEl = this.createFileListItem(tab);
      this.listContainer.appendChild(itemEl);
    }
  }

  /**
   * 特定のファイルアイテムのステータスを更新
   */
  updateItemStatus(tabId: string, status: VerificationStatus, progress?: number, progressDetails?: ProgressDetails): void {
    const itemEl = this.listContainer.querySelector(`[data-id="${tabId}"]`) as HTMLElement | null;
    if (!itemEl) return;

    // ステータスアイコンを更新
    const statusIcon = itemEl.querySelector('.file-status-icon');
    if (statusIcon) {
      statusIcon.className = `file-status-icon ${status}`;
    }

    // disabled状態を更新
    const isDisabled = !this.isSelectable(status);
    itemEl.classList.toggle('disabled', isDisabled);

    // 進捗表示を更新
    let progressEl = itemEl.querySelector('.file-progress') as HTMLElement | null;
    if (status === 'verifying') {
      if (!progressEl) {
        progressEl = document.createElement('span');
        progressEl.className = 'file-progress';
        itemEl.appendChild(progressEl);
      }
      // 詳細進捗があればそれを表示
      if (progressDetails && this.isEventCountPhase(progressDetails.phase)) {
        progressEl.textContent = `${progressDetails.current.toLocaleString()}/${progressDetails.total.toLocaleString()}`;
      } else if (progress !== undefined) {
        progressEl.textContent = `${progress}%`;
      }
    } else if (progressEl) {
      progressEl.remove();
    }
  }

  /**
   * アクティブアイテムの表示を更新
   */
  updateActiveItem(): void {
    const activeId = this.tabManager.getActiveTabId();

    // すべてのアイテムからactiveクラスを削除
    this.listContainer.querySelectorAll('.verify-file-item').forEach((el) => {
      el.classList.remove('active');
    });

    // アクティブなアイテムにactiveクラスを追加
    if (activeId) {
      const activeEl = this.listContainer.querySelector(`[data-id="${activeId}"]`);
      activeEl?.classList.add('active');
    }
  }

  /**
   * リストコンテナを取得
   */
  getContainer(): HTMLElement {
    return this.listContainer;
  }

  /**
   * クリーンアップ
   */
  destroy(): void {
    document.removeEventListener('mousemove', this.onResizeMove.bind(this));
    document.removeEventListener('mouseup', this.onResizeEnd.bind(this));
  }
}
