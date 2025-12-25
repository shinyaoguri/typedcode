/**
 * LogViewer - 操作ログを表示する読み取り専用ビューア
 */

export class LogViewer {
  constructor(containerElement, typingProof) {
    this.container = containerElement;
    this.typingProof = typingProof;
    this.isVisible = false;
    this.autoScroll = true;
  }

  /**
   * ログビューアの表示/非表示を切り替え
   */
  toggle() {
    this.isVisible = !this.isVisible;
    const logViewer = document.getElementById('log-viewer');
    const editorContainer = document.querySelector('.editor-container');

    if (this.isVisible) {
      logViewer.classList.add('visible');
      editorContainer.classList.add('with-log');
      this.refreshLogs();
    } else {
      logViewer.classList.remove('visible');
      editorContainer.classList.remove('with-log');
    }
  }

  /**
   * ログビューアを表示
   */
  show() {
    if (!this.isVisible) {
      this.toggle();
    }
  }

  /**
   * ログビューアを非表示
   */
  hide() {
    if (this.isVisible) {
      this.toggle();
    }
  }

  /**
   * ログを全て再描画
   */
  refreshLogs() {
    const events = this.typingProof.events;
    this.container.innerHTML = '';

    events.forEach((event, index) => {
      this.addLogEntry(event, index);
    });

    // 最下部にスクロール
    if (this.autoScroll) {
      this.scrollToBottom();
    }
  }

  /**
   * 新しいログエントリを追加
   */
  addLogEntry(event, index) {
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
    typeEl.textContent = event.inputType || event.type;

    const descEl = document.createElement('span');
    descEl.className = 'log-entry-description';
    descEl.textContent = event.description || this.getEventDescription(event);

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

      const parts = [];
      if (hasData) {
        parts.push(this.formatData(event.data));
      }
      if (hasSelectedText) {
        parts.push(this.formatData(event.selectedText));
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
      hashEl.title = event.hash; // フルハッシュをツールチップで表示
      entry.appendChild(hashEl);
    }

    this.container.appendChild(entry);

    // 自動スクロール
    if (this.autoScroll) {
      this.scrollToBottom();
    }
  }

  /**
   * イベントの説明を生成
   */
  getEventDescription(event) {
    switch (event.type) {
      case 'contentChange':
        return event.description || '内容変更';
      case 'cursorPositionChange':
        return 'カーソル移動';
      case 'selectionChange':
        return '選択範囲変更';
      case 'externalInput':
        return event.description || '外部入力';
      case 'editorInitialized':
        return 'エディタ初期化';
      default:
        return event.type;
    }
  }

  /**
   * イベントの詳細情報を生成
   */
  getEventDetails(event) {
    const details = [];

    if (event.range) {
      details.push(
        `位置: L${event.range.startLineNumber}:C${event.range.startColumn}`
      );
    }

    if (event.rangeLength !== undefined) {
      details.push(`範囲長: ${event.rangeLength}`);
    }

    if (event.deletedLength !== undefined) {
      details.push(`削除: ${event.deletedLength}文字`);
    }

    if (event.insertLength !== undefined) {
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
  formatData(data) {
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
  scrollToBottom() {
    const logContent = this.container.parentElement;
    if (logContent) {
      logContent.scrollTop = logContent.scrollHeight;
    }
  }

  /**
   * ログをクリア
   */
  clear() {
    this.container.innerHTML = '';
  }

  /**
   * ログをJSON形式でエクスポート
   */
  exportAsJSON() {
    const events = this.typingProof.events;
    const jsonString = JSON.stringify(events, null, 2);
    return jsonString;
  }

  /**
   * ログをテキスト形式でエクスポート
   */
  exportAsText() {
    const events = this.typingProof.events;
    let text = 'TypedCode 操作ログ\n';
    text += '='.repeat(50) + '\n\n';

    events.forEach((event, index) => {
      text += `[${index + 1}] ${(event.timestamp / 1000).toFixed(3)}s\n`;
      text += `  タイプ: ${event.inputType || event.type}\n`;
      text += `  説明: ${event.description || this.getEventDescription(event)}\n`;

      const details = this.getEventDetails(event);
      if (details) {
        text += `  詳細: ${details}\n`;
      }

      if (event.data && event.type === 'contentChange') {
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
  getStats() {
    const events = this.typingProof.events;
    const stats = {
      total: events.length,
      byType: {},
      byInputType: {}
    };

    events.forEach(event => {
      // type別カウント
      stats.byType[event.type] = (stats.byType[event.type] || 0) + 1;

      // inputType別カウント
      if (event.inputType) {
        stats.byInputType[event.inputType] = (stats.byInputType[event.inputType] || 0) + 1;
      }
    });

    return stats;
  }
}
