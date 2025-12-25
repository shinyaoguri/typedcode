/**
 * LogViewer - 操作ログを表示する読み取り専用ビューア
 */

import type { TypingProof } from './typingProof.js';
import type {
  StoredEvent,
  LogStats,
  EventType,
  InputType,
} from './types.js';

export class LogViewer {
  private container: HTMLElement;
  private typingProof: TypingProof;
  isVisible: boolean = false;
  private autoScroll: boolean = true;

  constructor(containerElement: HTMLElement, typingProof: TypingProof) {
    this.container = containerElement;
    this.typingProof = typingProof;
  }

  /**
   * ログビューアの表示/非表示を切り替え
   */
  toggle(): void {
    this.isVisible = !this.isVisible;
    const logViewer = document.getElementById('log-viewer');
    const editorContainer = document.querySelector('.editor-container') as HTMLElement | null;

    if (this.isVisible) {
      logViewer?.classList.add('visible');
      editorContainer?.classList.add('with-log');
      this.refreshLogs();
    } else {
      logViewer?.classList.remove('visible');
      editorContainer?.classList.remove('with-log');
      // リサイズで設定されたインラインスタイルをリセット
      if (logViewer) {
        logViewer.style.flex = '';
      }
      if (editorContainer) {
        editorContainer.style.flex = '';
      }
    }
  }

  /**
   * ログビューアを表示
   */
  show(): void {
    if (!this.isVisible) {
      this.toggle();
    }
  }

  /**
   * ログビューアを非表示
   */
  hide(): void {
    if (this.isVisible) {
      this.toggle();
    }
  }

  /**
   * ログを全て再描画
   */
  refreshLogs(): void {
    const events = this.typingProof.events;
    this.container.innerHTML = '';

    events.forEach((event, index) => {
      this.addLogEntry(event, index);
    });

    if (this.autoScroll) {
      this.scrollToBottom();
    }
  }

  /**
   * 新しいログエントリを追加
   */
  addLogEntry(event: StoredEvent, index: number): void {
    const entry = document.createElement('div');
    entry.className = `log-entry log-type-${event.type}`;

    // ヘッダー行（インデックス、タイムスタンプ、タイプ、説明を1行に）
    const header = document.createElement('div');
    header.className = 'log-entry-header';

    const indexEl = document.createElement('span');
    indexEl.className = 'log-entry-index';
    indexEl.textContent = `#${index + 1}`;

    const timeEl = document.createElement('span');
    timeEl.className = 'log-entry-time';
    timeEl.textContent = `${(event.timestamp / 1000).toFixed(2)}s`;

    const infoContainer = document.createElement('div');
    infoContainer.style.flex = '1';
    infoContainer.style.minWidth = '0';
    infoContainer.style.overflow = 'hidden';
    infoContainer.style.textOverflow = 'ellipsis';
    infoContainer.style.whiteSpace = 'nowrap';

    const typeEl = document.createElement('span');
    typeEl.className = 'log-entry-type';
    typeEl.textContent = event.inputType ?? event.type;

    const descEl = document.createElement('span');
    descEl.className = 'log-entry-description';
    descEl.textContent = event.description ?? this.getEventDescription(event);

    infoContainer.appendChild(typeEl);
    infoContainer.appendChild(descEl);

    header.appendChild(indexEl);
    header.appendChild(timeEl);
    header.appendChild(infoContainer);

    entry.appendChild(header);

    // 詳細情報（データと詳細を1行に）
    const details = this.getEventDetails(event);
    const hasData = event.data && event.type === 'contentChange';
    const hasSelectedText = event.selectedText && event.type === 'selectionChange';

    if (details || hasData || hasSelectedText) {
      const detailsLine = document.createElement('div');
      detailsLine.className = 'log-entry-details';

      const parts: string[] = [];
      if (hasData && typeof event.data === 'string') {
        parts.push(this.formatData(event.data));
      }
      if (hasSelectedText) {
        parts.push(this.formatData(event.selectedText!));
      }
      if (details) {
        parts.push(details);
      }

      detailsLine.textContent = parts.join(' | ');
      entry.appendChild(detailsLine);
    }

    // ハッシュ（ホバー時のみ表示）
    if (event.hash) {
      const hashEl = document.createElement('div');
      hashEl.className = 'log-entry-hash';
      hashEl.textContent = `${event.hash.substring(0, 16)}...`;
      hashEl.title = event.hash;
      entry.appendChild(hashEl);
    }

    this.container.appendChild(entry);

    if (this.autoScroll) {
      this.scrollToBottom();
    }
  }

  /**
   * イベントの説明を生成
   */
  private getEventDescription(event: StoredEvent): string {
    switch (event.type) {
      case 'contentChange':
        return event.description ?? '内容変更';
      case 'cursorPositionChange':
        return 'カーソル移動';
      case 'selectionChange':
        return '選択範囲変更';
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
  private getEventDetails(event: StoredEvent): string | null {
    const details: string[] = [];

    if (event.range) {
      details.push(
        `位置: L${event.range.startLineNumber}:C${event.range.startColumn}`
      );
    }

    if (event.rangeLength !== undefined && event.rangeLength !== null) {
      details.push(`範囲長: ${event.rangeLength}`);
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
  private formatData(data: string): string {
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
   * 最下部にスクロール
   */
  private scrollToBottom(): void {
    const logContent = this.container.parentElement;
    if (logContent) {
      logContent.scrollTop = logContent.scrollHeight;
    }
  }

  /**
   * ログをクリア
   */
  clear(): void {
    this.container.innerHTML = '';
  }

  /**
   * ログをJSON形式でエクスポート
   */
  exportAsJSON(): string {
    const events = this.typingProof.events;
    return JSON.stringify(events, null, 2);
  }

  /**
   * ログをテキスト形式でエクスポート
   */
  exportAsText(): string {
    const events = this.typingProof.events;
    let text = 'TypedCode 操作ログ\n';
    text += '='.repeat(50) + '\n\n';

    events.forEach((event, index) => {
      text += `[${index + 1}] ${(event.timestamp / 1000).toFixed(3)}s\n`;
      text += `  タイプ: ${event.inputType ?? event.type}\n`;
      text += `  説明: ${event.description ?? this.getEventDescription(event)}\n`;

      const details = this.getEventDetails(event);
      if (details) {
        text += `  詳細: ${details}\n`;
      }

      if (event.data && event.type === 'contentChange' && typeof event.data === 'string') {
        text += `  データ: ${this.formatData(event.data)}\n`;
      }

      text += `  ハッシュ: ${event.hash}\n`;
      text += '\n';
    });

    return text;
  }

  /**
   * 統計情報を表示
   */
  getStats(): LogStats {
    const events = this.typingProof.events;
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
}
