/**
 * チャートのイベント可視性設定に関する型定義
 */

import type { EventType } from '@typedcode/shared';

// ============================================================================
// イベントカテゴリ
// ============================================================================

/** イベントカテゴリ */
export type EventCategory =
  | 'content'
  | 'cursor'
  | 'input'
  | 'window'
  | 'system'
  | 'auth'
  | 'execution'
  | 'capture';

/** カテゴリ情報 */
export interface CategoryInfo {
  id: EventCategory;
  labelKey: string;
  icon: string;
  events: EventType[];
}

/** イベントタイプからカテゴリへのマッピング */
export const EVENT_CATEGORY_MAP: Record<EventType, EventCategory> = {
  // Content
  contentChange: 'content',
  contentSnapshot: 'content',
  externalInput: 'content',
  // Cursor
  cursorPositionChange: 'cursor',
  selectionChange: 'cursor',
  // Input
  keyDown: 'input',
  keyUp: 'input',
  mousePositionChange: 'input',
  // Window
  focusChange: 'window',
  visibilityChange: 'window',
  windowResize: 'window',
  // System
  editorInitialized: 'system',
  networkStatusChange: 'system',
  // Auth
  humanAttestation: 'auth',
  preExportAttestation: 'auth',
  termsAccepted: 'auth',
  // Execution
  codeExecution: 'execution',
  terminalInput: 'execution',
  // Capture
  screenshotCapture: 'capture',
  screenShareStart: 'capture',
  screenShareStop: 'capture',
  templateInjection: 'capture',
};

/** カテゴリ定義（UI表示用） */
export const EVENT_CATEGORIES: CategoryInfo[] = [
  {
    id: 'content',
    labelKey: 'charts.categories.content',
    icon: 'fa-file-lines',
    events: ['contentChange', 'contentSnapshot', 'externalInput'],
  },
  {
    id: 'cursor',
    labelKey: 'charts.categories.cursor',
    icon: 'fa-i-cursor',
    events: ['cursorPositionChange', 'selectionChange'],
  },
  {
    id: 'input',
    labelKey: 'charts.categories.input',
    icon: 'fa-keyboard',
    events: ['keyDown', 'keyUp', 'mousePositionChange'],
  },
  {
    id: 'window',
    labelKey: 'charts.categories.window',
    icon: 'fa-window-maximize',
    events: ['focusChange', 'visibilityChange', 'windowResize'],
  },
  {
    id: 'system',
    labelKey: 'charts.categories.system',
    icon: 'fa-cog',
    events: ['editorInitialized', 'networkStatusChange'],
  },
  {
    id: 'auth',
    labelKey: 'charts.categories.auth',
    icon: 'fa-user-check',
    events: ['humanAttestation', 'preExportAttestation', 'termsAccepted'],
  },
  {
    id: 'execution',
    labelKey: 'charts.categories.execution',
    icon: 'fa-play',
    events: ['codeExecution', 'terminalInput'],
  },
  {
    id: 'capture',
    labelKey: 'charts.categories.capture',
    icon: 'fa-camera',
    events: ['screenshotCapture', 'screenShareStart', 'screenShareStop', 'templateInjection'],
  },
];

// ============================================================================
// 可視性設定
// ============================================================================

/** チャートイベント可視性設定 */
export interface ChartEventVisibility {
  /** カテゴリ単位の表示設定 */
  categories: Record<EventCategory, boolean>;
  /** 個別イベントのオーバーライド設定（設定がない場合はカテゴリ設定に従う） */
  events: Partial<Record<EventType, boolean>>;
}

/** デフォルトの可視性設定 */
export const DEFAULT_CHART_EVENT_VISIBILITY: ChartEventVisibility = {
  categories: {
    content: true,
    cursor: false,
    input: true,
    window: true,
    system: false,
    auth: true,
    execution: true,
    capture: true,
  },
  events: {},
};

// ============================================================================
// ヘルパー関数
// ============================================================================

/**
 * イベントタイプが表示対象かどうかを判定
 */
export function isEventTypeVisible(
  eventType: EventType,
  visibility: ChartEventVisibility
): boolean {
  // 個別オーバーライドがあればそれを使用
  if (eventType in visibility.events) {
    return visibility.events[eventType] ?? false;
  }
  // なければカテゴリ設定に従う
  const category = EVENT_CATEGORY_MAP[eventType];
  return visibility.categories[category] ?? false;
}

/**
 * カテゴリ内の全イベントが表示対象かどうかを判定
 */
export function isCategoryFullyVisible(
  category: EventCategory,
  visibility: ChartEventVisibility
): boolean {
  const categoryInfo = EVENT_CATEGORIES.find((c) => c.id === category);
  if (!categoryInfo) return false;

  return categoryInfo.events.every((event) => isEventTypeVisible(event, visibility));
}

/**
 * カテゴリ内の一部イベントが表示対象かどうかを判定（部分選択状態）
 */
export function isCategoryPartiallyVisible(
  category: EventCategory,
  visibility: ChartEventVisibility
): boolean {
  const categoryInfo = EVENT_CATEGORIES.find((c) => c.id === category);
  if (!categoryInfo) return false;

  const visibleCount = categoryInfo.events.filter((event) =>
    isEventTypeVisible(event, visibility)
  ).length;

  return visibleCount > 0 && visibleCount < categoryInfo.events.length;
}
