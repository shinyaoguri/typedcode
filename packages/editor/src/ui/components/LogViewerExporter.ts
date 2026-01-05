/**
 * LogViewerExporter - ログのエクスポート機能
 */

import type {
  StoredEvent,
  LogStats,
  EventType,
  InputType,
} from '@typedcode/shared';

/**
 * イベントの説明を生成
 */
function getEventDescription(event: StoredEvent): string {
  switch (event.type) {
    case 'contentChange':
      return event.description ?? '内容変更';
    case 'cursorPositionChange':
      return 'カーソル移動';
    case 'selectionChange':
      return '選択変更';
    case 'externalInput':
      return event.description ?? '外部入力';
    case 'editorInitialized':
      return 'エディタ初期化';
    case 'contentSnapshot':
      return 'スナップショット';
    default:
      return event.type;
  }
}

/**
 * イベントの詳細情報を生成
 */
function getEventDetails(event: StoredEvent): string | null {
  const details: string[] = [];

  if (event.range) {
    details.push(`位置: L${event.range.startLineNumber}:${event.range.startColumn}`);
  }

  if (event.rangeLength !== undefined && event.rangeLength !== null) {
    details.push(`範囲: ${event.rangeLength}文字`);
  }

  if (event.deletedLength !== undefined && event.deletedLength !== null) {
    details.push(`削除: ${event.deletedLength}文字`);
  }

  if (event.insertLength !== undefined && event.insertLength !== null) {
    details.push(`挿入: ${event.insertLength}文字`);
  }

  if (event.deleteDirection) {
    details.push(`方向: ${event.deleteDirection}`);
  }

  if (event.isMultiLine) {
    details.push('複数行');
  }

  return details.length > 0 ? details.join(' | ') : null;
}

/**
 * データを表示用にフォーマット
 */
function formatData(data: string): string {
  if (!data) return '';

  // 改行を可視化
  let formatted = data
    .replace(/\n/g, '↵')
    .replace(/\t/g, '→')
    .replace(/\r/g, '');

  // 長すぎる場合は切り詰め
  if (formatted.length > 100) {
    formatted = formatted.substring(0, 100) + '...';
  }

  return `"${formatted}"`;
}

/**
 * ログをJSON形式でエクスポート
 */
export function exportAsJSON(events: StoredEvent[]): string {
  return JSON.stringify(events, null, 2);
}

/**
 * ログをテキスト形式でエクスポート
 */
export function exportAsText(events: StoredEvent[]): string {
  let text = 'TypedCode 操作ログ\n';
  text += '='.repeat(50) + '\n\n';

  events.forEach((event, index) => {
    text += `[${index + 1}] ${(event.timestamp / 1000).toFixed(3)}s\n`;
    text += `  タイプ: ${event.inputType ?? event.type}\n`;
    text += `  説明: ${event.description ?? getEventDescription(event)}\n`;

    const details = getEventDetails(event);
    if (details) {
      text += `  詳細: ${details}\n`;
    }

    if (event.data && event.type === 'contentChange' && typeof event.data === 'string') {
      text += `  データ: ${formatData(event.data)}\n`;
    }

    text += `  ハッシュ: ${event.hash}\n`;
    text += '\n';
  });

  return text;
}

/**
 * 統計情報を取得
 */
export function getStats(events: StoredEvent[]): LogStats {
  const stats: LogStats = {
    total: events.length,
    byType: {},
    byInputType: {}
  };

  events.forEach(event => {
    const eventType = event.type as EventType;
    stats.byType[eventType] = (stats.byType[eventType] ?? 0) + 1;

    if (event.inputType) {
      const inputType = event.inputType as InputType;
      stats.byInputType[inputType] = (stats.byInputType[inputType] ?? 0) + 1;
    }
  });

  return stats;
}
