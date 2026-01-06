/**
 * ChartEventSelector - チャートに表示するイベントを選択するUIコンポーネント
 */

import type { EventType } from '@typedcode/shared';
import type { EventCategory, ChartEventVisibility, CategoryInfo } from '../types/chartVisibility.js';
import {
  EVENT_CATEGORIES,
  DEFAULT_CHART_EVENT_VISIBILITY,
  isEventTypeVisible,
  isCategoryFullyVisible,
  isCategoryPartiallyVisible,
} from '../types/chartVisibility.js';
import { ChartPreferencesService } from '../services/ChartPreferencesService.js';
import { t } from '../i18n/index.js';

// ============================================================================
// 型定義
// ============================================================================

export interface ChartEventSelectorOptions {
  /** ボタン要素 */
  button: HTMLElement;
  /** ドロップダウンコンテナ要素 */
  dropdown: HTMLElement;
  /** 可視性変更時のコールバック */
  onVisibilityChange: (visibility: ChartEventVisibility) => void;
}

// ============================================================================
// ChartEventSelector
// ============================================================================

/**
 * チャートに表示するイベントを選択するUIコンポーネント
 */
export class ChartEventSelector {
  private button: HTMLElement;
  private dropdown: HTMLElement;
  private visibility: ChartEventVisibility;
  private onVisibilityChange: (visibility: ChartEventVisibility) => void;
  private isOpen = false;
  private expandedCategories: Set<EventCategory> = new Set();

  constructor(options: ChartEventSelectorOptions) {
    this.button = options.button;
    this.dropdown = options.dropdown;
    this.onVisibilityChange = options.onVisibilityChange;

    // 保存された設定を読み込む
    const prefs = ChartPreferencesService.load();
    this.visibility = prefs.eventVisibility;

    this.setupEventListeners();
    this.render();
  }

  // ==========================================================================
  // イベントリスナー
  // ==========================================================================

  private setupEventListeners(): void {
    // ボタンクリックでドロップダウン開閉
    this.button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });

    // 外側クリックで閉じる
    document.addEventListener('click', (e) => {
      if (this.isOpen && !this.dropdown.contains(e.target as Node)) {
        this.close();
      }
    });

    // Escapeキーで閉じる
    document.addEventListener('keydown', (e) => {
      if (this.isOpen && e.key === 'Escape') {
        this.close();
      }
    });
  }

  // ==========================================================================
  // 開閉制御
  // ==========================================================================

  toggle(): void {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  open(): void {
    this.isOpen = true;
    this.dropdown.classList.add('show');
    this.button.classList.add('active');
  }

  close(): void {
    this.isOpen = false;
    this.dropdown.classList.remove('show');
    this.button.classList.remove('active');
  }

  // ==========================================================================
  // レンダリング
  // ==========================================================================

  private render(): void {
    this.dropdown.innerHTML = '';

    // ヘッダー
    const header = document.createElement('div');
    header.className = 'event-selector-header';
    header.innerHTML = `
      <span>${t('charts.eventFilter') || 'Event Filter'}</span>
      <button class="event-selector-reset" title="${t('common.reset') || 'Reset'}">
        <i class="fas fa-undo"></i>
      </button>
    `;
    header.querySelector('.event-selector-reset')?.addEventListener('click', () => {
      this.reset();
    });
    this.dropdown.appendChild(header);

    // カテゴリリスト
    const list = document.createElement('div');
    list.className = 'event-selector-list';

    for (const category of EVENT_CATEGORIES) {
      const categoryEl = this.renderCategory(category);
      list.appendChild(categoryEl);
    }

    this.dropdown.appendChild(list);
  }

  private renderCategory(category: CategoryInfo): HTMLElement {
    const isExpanded = this.expandedCategories.has(category.id);
    const isFullyVisible = isCategoryFullyVisible(category.id, this.visibility);
    const isPartiallyVisible = isCategoryPartiallyVisible(category.id, this.visibility);

    const container = document.createElement('div');
    container.className = `event-category ${isExpanded ? 'expanded' : ''}`;
    container.dataset.category = category.id;

    // カテゴリヘッダー
    const header = document.createElement('div');
    header.className = 'event-category-header';
    header.innerHTML = `
      <input type="checkbox"
             class="event-category-checkbox"
             ${isFullyVisible ? 'checked' : ''}
             ${isPartiallyVisible ? 'data-indeterminate="true"' : ''}>
      <i class="fas ${category.icon} event-category-icon"></i>
      <span class="event-category-label">${t(category.labelKey) || category.id}</span>
      <span class="event-category-count">${category.events.length}</span>
      <i class="fas fa-chevron-down event-category-expand"></i>
    `;

    // チェックボックスの状態更新
    const checkbox = header.querySelector('.event-category-checkbox') as HTMLInputElement;
    if (isPartiallyVisible && !isFullyVisible) {
      checkbox.indeterminate = true;
    }

    // チェックボックスクリック
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    checkbox.addEventListener('change', () => {
      this.toggleCategory(category.id);
    });

    // ヘッダークリックで展開/折りたたみ
    header.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).tagName !== 'INPUT') {
        this.toggleCategoryExpansion(category.id);
      }
    });

    container.appendChild(header);

    // イベントリスト
    const eventList = document.createElement('div');
    eventList.className = 'event-items';

    for (const eventType of category.events) {
      const eventEl = this.renderEventItem(eventType);
      eventList.appendChild(eventEl);
    }

    container.appendChild(eventList);

    return container;
  }

  private renderEventItem(eventType: EventType): HTMLElement {
    const isVisible = isEventTypeVisible(eventType, this.visibility);

    const item = document.createElement('label');
    item.className = 'event-item';
    item.innerHTML = `
      <input type="checkbox" class="event-item-checkbox" ${isVisible ? 'checked' : ''}>
      <span class="event-item-label">${t(`charts.events.${eventType}`) || eventType}</span>
    `;

    const checkbox = item.querySelector('.event-item-checkbox') as HTMLInputElement;
    checkbox.addEventListener('change', () => {
      this.toggleEvent(eventType);
    });

    return item;
  }

  // ==========================================================================
  // 状態変更
  // ==========================================================================

  private toggleCategory(category: EventCategory): void {
    const categoryInfo = EVENT_CATEGORIES.find((c) => c.id === category);
    if (!categoryInfo) return;

    const isFullyVisible = isCategoryFullyVisible(category, this.visibility);

    // 完全に表示されている場合は全て非表示に、そうでなければ全て表示に
    const newState = !isFullyVisible;

    // カテゴリ設定を更新
    this.visibility.categories[category] = newState;

    // 個別オーバーライドをクリア（カテゴリ設定に戻す）
    for (const eventType of categoryInfo.events) {
      delete this.visibility.events[eventType];
    }

    this.saveAndNotify();
    this.updateUI();
  }

  private toggleEvent(eventType: EventType): void {
    const currentState = isEventTypeVisible(eventType, this.visibility);
    this.visibility.events[eventType] = !currentState;

    this.saveAndNotify();
    this.updateUI();
  }

  private toggleCategoryExpansion(category: EventCategory): void {
    if (this.expandedCategories.has(category)) {
      this.expandedCategories.delete(category);
    } else {
      this.expandedCategories.add(category);
    }
    this.updateUI();
  }

  private reset(): void {
    this.visibility = { ...DEFAULT_CHART_EVENT_VISIBILITY };
    this.saveAndNotify();
    this.updateUI();
  }

  /**
   * UIを更新（メニューを閉じずにチェックボックスの状態のみ更新）
   */
  private updateUI(): void {
    // 各カテゴリの状態を更新
    for (const category of EVENT_CATEGORIES) {
      const container = this.dropdown.querySelector(`[data-category="${category.id}"]`);
      if (!container) continue;

      const isExpanded = this.expandedCategories.has(category.id);
      const isFullyVisible = isCategoryFullyVisible(category.id, this.visibility);
      const isPartiallyVisible = isCategoryPartiallyVisible(category.id, this.visibility);

      // コンテナのexpandedクラスを更新
      container.classList.toggle('expanded', isExpanded);

      // カテゴリチェックボックスを更新
      const categoryCheckbox = container.querySelector('.event-category-checkbox') as HTMLInputElement;
      if (categoryCheckbox) {
        categoryCheckbox.checked = isFullyVisible;
        categoryCheckbox.indeterminate = isPartiallyVisible && !isFullyVisible;
      }

      // 個別イベントのチェックボックスを更新
      const eventItems = container.querySelectorAll('.event-item');
      const events = category.events;
      eventItems.forEach((item, idx) => {
        const checkbox = item.querySelector('.event-item-checkbox') as HTMLInputElement;
        const eventType = events[idx];
        if (checkbox && eventType) {
          checkbox.checked = isEventTypeVisible(eventType, this.visibility);
        }
      });
    }
  }

  private saveAndNotify(): void {
    ChartPreferencesService.saveVisibility(this.visibility);
    this.onVisibilityChange(this.visibility);
  }

  // ==========================================================================
  // 公開メソッド
  // ==========================================================================

  getVisibility(): ChartEventVisibility {
    return this.visibility;
  }

  setVisibility(visibility: ChartEventVisibility): void {
    this.visibility = visibility;
    this.saveAndNotify();
    this.render();
  }
}
