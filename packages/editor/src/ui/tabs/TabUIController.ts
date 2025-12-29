/**
 * TabUIController - タブUIのDOM操作を管理
 * タブの作成、更新、ファイル名編集、言語アイコン表示を制御
 */

import type { TabManager, TabState } from './TabManager.js';
import {
  getLanguageDefinition,
  FILE_EXTENSIONS,
} from '../../config/SupportedLanguages.js';
import { t } from '../../i18n/index.js';

export interface TabUIControllerOptions {
  container: HTMLElement;
  tabManager: TabManager;
  basePath: string;
  onNotification?: (message: string) => void;
}

/** ドラッグ状態 */
interface DragState {
  isDragging: boolean;
  draggedTabId: string | null;
  draggedElement: HTMLElement | null;
  placeholder: HTMLElement | null;
  ghost: HTMLElement | null;
  startX: number;
  offsetX: number;
  offsetY: number;
  initialIndex: number;
  initialRect: DOMRect | null;
}

export class TabUIController {
  private container: HTMLElement;
  private tabManager: TabManager;
  private basePath: string;
  private onNotification: ((message: string) => void) | null = null;

  // ドラッグ&ドロップ関連
  private dragState: DragState = {
    isDragging: false,
    draggedTabId: null,
    draggedElement: null,
    placeholder: null,
    ghost: null,
    startX: 0,
    offsetX: 0,
    offsetY: 0,
    initialIndex: -1,
    initialRect: null,
  };
  private boundMouseMove: ((e: MouseEvent) => void) | null = null;
  private boundMouseUp: ((e: MouseEvent) => void) | null = null;

  constructor(options: TabUIControllerOptions) {
    this.container = options.container;
    this.tabManager = options.tabManager;
    this.basePath = options.basePath;
    this.onNotification = options.onNotification ?? null;
  }

  /**
   * ファイル拡張子を取得
   */
  getFileExtension(language: string): string {
    return FILE_EXTENSIONS[language] ?? 'txt';
  }

  /**
   * 次の Untitled 番号を取得
   */
  getNextUntitledNumber(): number {
    const tabs = this.tabManager.getAllTabs();
    const untitledNumbers: number[] = [];
    for (const tab of tabs) {
      const match = tab.filename.match(/^Untitled-(\d+)$/i);
      if (match) {
        untitledNumbers.push(parseInt(match[1]!, 10));
      }
    }
    if (untitledNumbers.length === 0) return 1;
    return Math.max(...untitledNumbers) + 1;
  }

  /**
   * タブUI要素を生成
   */
  createTabElement(tab: TabState): HTMLElement {
    const tabEl = document.createElement('div');
    tabEl.className = 'editor-tab';
    tabEl.dataset.tabId = tab.id;

    if (this.tabManager.getActiveTab()?.id === tab.id) {
      tabEl.classList.add('active');
    }
    const ext = '.' + this.getFileExtension(tab.language);

    // SVGアイコンがあればimgタグ、なければFont Awesomeのデフォルトアイコン
    const langDef = getLanguageDefinition(tab.language);
    const hasSvgIcon = langDef?.hasSvgIcon ?? false;
    const iconHtml = hasSvgIcon
      ? `<img src="${this.basePath}icons/${tab.language}.svg" class="tab-icon" alt="${tab.language}" />`
      : `<i class="fas fa-file-code tab-icon"></i>`;

    // 認証状態のインジケーター
    const verificationIndicator = this.createVerificationIndicator(tab);

    tabEl.innerHTML = `
      ${iconHtml}
      <span class="tab-filename">${tab.filename}</span>
      <span class="tab-extension">${ext}</span>
      ${verificationIndicator}
      <button class="tab-close-btn" title="Close Tab"><i class="fas fa-times"></i></button>
    `;

    // タブクリックで切り替え
    tabEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      // 閉じるボタンのクリックは除外
      if (target.closest('.tab-close-btn')) return;
      // ファイル名クリックは編集モードに（アクティブタブの場合のみ）
      if (target.closest('.tab-filename') || target.closest('.tab-extension')) {
        if (this.tabManager.getActiveTab()?.id === tab.id) {
          e.stopPropagation();
          this.startFilenameEdit(tabEl, tab.id);
          return;
        }
      }
      this.tabManager.switchTab(tab.id);
    });

    // 閉じるボタン
    const closeBtn = tabEl.querySelector('.tab-close-btn');
    closeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.tabManager.getTabCount() === 1) {
        this.onNotification?.(t('tabs.lastTabWarning'));
        return;
      }
      const targetTab = this.tabManager.getTab(tab.id);
      const tabName = targetTab
        ? `${targetTab.filename}.${this.getFileExtension(targetTab.language)}`
        : t('tabs.untitled');
      if (confirm(t('tabs.closeConfirm', { tabName }))) {
        this.tabManager.closeTab(tab.id);
      }
    });

    // ドラッグイベントを設定
    this.setupDragEvents(tabEl, tab.id);

    return tabEl;
  }

  /**
   * 認証状態のインジケーターHTMLを生成
   */
  private createVerificationIndicator(tab: TabState): string {
    if (tab.verificationState === 'verified') {
      const timestamp = tab.verificationDetails?.timestamp
        ? new Date(tab.verificationDetails.timestamp).toLocaleString()
        : '';
      const tooltip = timestamp
        ? `✓ ${t('tabs.verifiedTooltip')}\n${timestamp}`
        : `✓ ${t('tabs.verifiedTooltip')}`;
      return `<span class="tab-verification verified" title="${tooltip}"></span>`;
    } else if (tab.verificationState === 'failed') {
      const timestamp = tab.verificationDetails?.timestamp
        ? new Date(tab.verificationDetails.timestamp).toLocaleString()
        : '';
      const reason = tab.verificationDetails?.failureReason;
      const reasonText =
        reason === 'timeout'
          ? t('tabs.failureTimeout')
          : reason === 'network_error'
            ? t('tabs.failureNetworkError')
            : reason === 'challenge_failed'
              ? t('tabs.failureChallengeFailed')
              : reason === 'token_acquisition_failed'
                ? t('tabs.failureTokenFailed')
                : t('tabs.failureUnknown');
      const tooltip = `✗ ${t('tabs.failedTooltip')}\n${reasonText}${timestamp ? `\n${timestamp}` : ''}`;
      return `<span class="tab-verification failed" title="${tooltip}"></span>`;
    }
    return '';
  }

  /**
   * タブUIを更新
   */
  updateUI(): void {
    // 全タブを再生成
    this.container.innerHTML = '';
    for (const tab of this.tabManager.getAllTabs()) {
      const tabEl = this.createTabElement(tab);
      this.container.appendChild(tabEl);
    }
  }

  /**
   * ファイル名編集モードを開始
   */
  startFilenameEdit(tabEl: HTMLElement, tabId: string): void {
    const filenameSpan = tabEl.querySelector('.tab-filename') as HTMLElement | null;
    if (!filenameSpan) return;

    const tab = this.tabManager.getTab(tabId);
    if (!tab) return;

    const currentName = tab.filename;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tab-filename-input';
    input.value = currentName;

    const finishEdit = (): void => {
      const newName = input.value.trim() || 'untitled';
      this.tabManager.renameTab(tabId, newName);
      filenameSpan.textContent = newName;
      filenameSpan.style.display = '';
      input.remove();
    };

    input.addEventListener('blur', finishEdit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = currentName;
        input.blur();
      }
    });

    filenameSpan.style.display = 'none';
    filenameSpan.parentElement?.insertBefore(input, filenameSpan);
    input.focus();
    input.select();
  }

  // ========================================
  // ドラッグ&ドロップ関連メソッド
  // ========================================

  /**
   * タブ要素にドラッグイベントを設定
   */
  private setupDragEvents(tabEl: HTMLElement, tabId: string): void {
    tabEl.addEventListener('mousedown', (e: MouseEvent) => {
      // 閉じるボタンやファイル名編集中は除外
      const target = e.target as HTMLElement;
      if (target.closest('.tab-close-btn') || target.closest('.tab-filename-input')) {
        return;
      }

      // 左クリックのみ
      if (e.button !== 0) return;

      this.startDrag(e, tabEl, tabId);
    });
  }

  /**
   * ドラッグ開始
   */
  private startDrag(e: MouseEvent, tabEl: HTMLElement, tabId: string): void {
    const rect = tabEl.getBoundingClientRect();
    const tabs = this.tabManager.getAllTabs();
    const index = tabs.findIndex(t => t.id === tabId);

    if (index === -1) return;

    // ゴースト要素を作成
    const ghost = this.createGhost(tabEl);
    document.body.appendChild(ghost);

    this.dragState = {
      isDragging: true,
      draggedTabId: tabId,
      draggedElement: tabEl,
      placeholder: this.createPlaceholder(tabEl),
      ghost: ghost,
      startX: e.clientX,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      initialIndex: index,
      initialRect: rect,
    };

    // ゴーストの初期位置を設定
    this.updateGhostPosition(e.clientX, e.clientY);

    // ドラッグ中のスタイル（タブは元の位置に残る）
    tabEl.classList.add('dragging');
    document.body.classList.add('tab-dragging');

    // グローバルイベントリスナー
    this.boundMouseMove = this.handleMouseMove.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);
    document.addEventListener('mousemove', this.boundMouseMove);
    document.addEventListener('mouseup', this.boundMouseUp);
  }

  /**
   * ドラッグ中のマウス移動
   */
  private handleMouseMove(e: MouseEvent): void {
    if (!this.dragState.isDragging || !this.dragState.draggedElement || !this.dragState.initialRect) return;

    // ゴーストの位置を更新
    this.updateGhostPosition(e.clientX, e.clientY);

    // ドロップ位置の更新（セパレータを表示）
    this.updateDropPosition(e.clientX);
  }

  /**
   * ドラッグ終了
   */
  private handleMouseUp(e: MouseEvent): void {
    if (!this.dragState.isDragging) return;

    // 最終的なドロップ位置を計算
    const newIndex = this.calculateDropIndex(e.clientX);

    // 位置が変わった場合のみ順序を更新
    if (newIndex !== -1 && newIndex !== this.dragState.initialIndex) {
      this.tabManager.reorderTab(this.dragState.initialIndex, newIndex);
    }

    // クリーンアップ
    this.cleanupDrag();
  }

  /**
   * ドロップ位置のインデックスを計算
   */
  private calculateDropIndex(clientX: number): number {
    const tabs = this.tabManager.getAllTabs();
    const tabElements = Array.from(
      this.container.querySelectorAll('.editor-tab')
    ) as HTMLElement[];

    let dropIndex = tabs.length - 1;

    for (let i = 0; i < tabElements.length; i++) {
      const tab = tabElements[i]!;

      // ドラッグ中のタブはスキップ
      if (tab === this.dragState.draggedElement) {
        continue;
      }

      const rect = tab.getBoundingClientRect();
      const midPoint = rect.left + rect.width / 2;

      if (clientX < midPoint) {
        // このタブのインデックスを取得
        const tabId = tab.dataset.tabId;
        const tabIndex = tabs.findIndex(t => t.id === tabId);

        if (tabIndex !== -1) {
          // ドラッグ元より後ろに挿入する場合は調整
          if (tabIndex > this.dragState.initialIndex) {
            dropIndex = tabIndex - 1;
          } else {
            dropIndex = tabIndex;
          }
        }
        break;
      }
    }

    return dropIndex;
  }

  /**
   * プレースホルダの位置を更新
   */
  private updateDropPosition(clientX: number): void {
    const placeholder = this.dragState.placeholder;
    if (!placeholder) return;

    // 全タブを取得（ドラッグ中のタブも含む）
    const tabElements = Array.from(
      this.container.querySelectorAll('.editor-tab')
    ) as HTMLElement[];

    // プレースホルダが既に挿入されている場合は一旦削除
    placeholder.remove();

    let insertBeforeElement: HTMLElement | null = null;

    for (let i = 0; i < tabElements.length; i++) {
      const tab = tabElements[i]!;
      const rect = tab.getBoundingClientRect();
      const midPoint = rect.left + rect.width / 2;

      if (clientX < midPoint) {
        // ドラッグ中のタブ自身の場合はスキップ（自分の前に挿入しない）
        if (tab === this.dragState.draggedElement) {
          continue;
        }
        insertBeforeElement = tab;
        break;
      }
    }

    if (insertBeforeElement) {
      this.container.insertBefore(placeholder, insertBeforeElement);
    } else {
      // 最後に配置
      this.container.appendChild(placeholder);
    }
  }

  /**
   * ゴースト要素（マウスに追従する半透明タブ）を作成
   */
  private createGhost(sourceElement: HTMLElement): HTMLElement {
    const ghost = document.createElement('div');
    ghost.className = 'editor-tab-ghost';

    // アイコンとファイル名を取得してコピー
    const icon = sourceElement.querySelector('.tab-icon');
    const filename = sourceElement.querySelector('.tab-filename');
    const extension = sourceElement.querySelector('.tab-extension');

    if (icon) {
      ghost.appendChild(icon.cloneNode(true));
    }
    if (filename) {
      ghost.appendChild(filename.cloneNode(true));
    }
    if (extension) {
      ghost.appendChild(extension.cloneNode(true));
    }

    return ghost;
  }

  /**
   * ゴーストの位置を更新
   */
  private updateGhostPosition(clientX: number, clientY: number): void {
    const ghost = this.dragState.ghost;
    if (!ghost) return;

    ghost.style.left = `${clientX - this.dragState.offsetX}px`;
    ghost.style.top = `${clientY - this.dragState.offsetY}px`;
  }

  /**
   * セパレータ（ドロップ位置インジケータ）を作成
   */
  private createPlaceholder(_sourceElement: HTMLElement): HTMLElement {
    const placeholder = document.createElement('div');
    placeholder.className = 'editor-tab-placeholder';
    // 幅と高さはCSSで定義（セパレータスタイル）
    return placeholder;
  }

  /**
   * ドラッグ終了時のクリーンアップ
   */
  private cleanupDrag(): void {
    if (this.dragState.draggedElement) {
      this.dragState.draggedElement.classList.remove('dragging');
    }

    this.dragState.placeholder?.remove();
    this.dragState.ghost?.remove();

    document.body.classList.remove('tab-dragging');

    if (this.boundMouseMove) {
      document.removeEventListener('mousemove', this.boundMouseMove);
      this.boundMouseMove = null;
    }
    if (this.boundMouseUp) {
      document.removeEventListener('mouseup', this.boundMouseUp);
      this.boundMouseUp = null;
    }

    this.dragState = {
      isDragging: false,
      draggedTabId: null,
      draggedElement: null,
      placeholder: null,
      ghost: null,
      startX: 0,
      offsetX: 0,
      offsetY: 0,
      initialIndex: -1,
      initialRect: null,
    };

    // UIを更新（タブ順序を反映）
    this.updateUI();
  }

  /**
   * リソースを解放
   */
  dispose(): void {
    this.cleanupDrag();
    this.container.innerHTML = '';
    this.onNotification = null;
  }
}
