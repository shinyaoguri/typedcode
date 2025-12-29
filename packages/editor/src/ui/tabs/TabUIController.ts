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

export class TabUIController {
  private container: HTMLElement;
  private tabManager: TabManager;
  private basePath: string;
  private onNotification: ((message: string) => void) | null = null;

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

  /**
   * リソースを解放
   */
  dispose(): void {
    this.container.innerHTML = '';
    this.onNotification = null;
  }
}
