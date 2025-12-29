/**
 * MetadataPanel - メタデータ表示パネル
 *
 * 証明ファイルのメタデータ（バージョン、言語、タイムスタンプなど）と
 * タイピング統計（イベント数、タイピング時間など）を表示します。
 */

import type { StoredEvent } from '@typedcode/shared';
import type { IPanel, PanelRenderContext } from './types.js';

/** MetadataPanel の設定 */
export interface MetadataPanelOptions {
  // ===== 基本メタデータ =====
  /** バージョン要素 */
  versionEl: HTMLElement | null;
  /** 言語要素 */
  languageEl: HTMLElement | null;
  /** タイムスタンプ要素 */
  timestampEl: HTMLElement | null;
  /** UserAgent要素 */
  userAgentEl: HTMLElement | null;

  // ===== タイピング統計 =====
  /** デバイスID要素 */
  deviceIdEl: HTMLElement | null;
  /** 総イベント数要素 */
  totalEventsEl: HTMLElement | null;
  /** 挿入イベント数要素 */
  insertEventsEl: HTMLElement | null;
  /** 削除イベント数要素 */
  deleteEventsEl: HTMLElement | null;
  /** タイピング時間要素 */
  typingTimeEl: HTMLElement | null;
  /** タイピング速度要素 */
  typingSpeedEl: HTMLElement | null;

  // ===== Pure Typing バッジ =====
  /** Pure Typingバッジ要素 */
  pureTypingBadgeEl: HTMLElement | null;
  /** ペースト情報要素 */
  pasteInfoEl: HTMLElement | null;

  // ===== 外部入力プレビュー =====
  /** 外部入力プレビューコンテナ */
  externalInputPreviewEl: HTMLElement | null;
  /** 外部入力リスト */
  externalInputListEl: HTMLElement | null;

  // ===== コンテンツプレビュー =====
  /** コンテンツプレビュー要素 */
  contentPreviewEl: HTMLElement | null;
}

/**
 * メタデータ表示パネル
 */
export class MetadataPanel implements IPanel {
  private options: MetadataPanelOptions;

  constructor(options: MetadataPanelOptions) {
    this.options = options;
  }

  render(context: PanelRenderContext): void {
    const { proofData, isPureTyping } = context;

    // 基本メタデータ
    this.renderBasicMetadata(proofData);

    // タイピング統計
    this.renderTypingStats(proofData);

    // Pure Typing バッジ
    this.renderPureTypingBadge(proofData, isPureTyping);

    // 外部入力
    if (proofData.proof?.events) {
      this.renderExternalInputs(proofData.proof.events);
    }

    // コンテンツプレビュー
    this.renderContentPreview(proofData.content);
  }

  /**
   * 基本メタデータをレンダリング
   */
  private renderBasicMetadata(proofData: PanelRenderContext['proofData']): void {
    if (this.options.versionEl) {
      this.options.versionEl.textContent = proofData.version ?? '-';
    }
    if (this.options.languageEl) {
      this.options.languageEl.textContent = proofData.language ?? '-';
    }
    if (this.options.timestampEl) {
      this.options.timestampEl.textContent = proofData.metadata?.timestamp ?? '-';
    }
    if (this.options.userAgentEl) {
      this.options.userAgentEl.textContent = proofData.metadata?.userAgent ?? '-';
    }
  }

  /**
   * タイピング統計をレンダリング
   */
  private renderTypingStats(proofData: PanelRenderContext['proofData']): void {
    if (!proofData.typingProofData) return;

    const { deviceId, metadata } = proofData.typingProofData;

    if (this.options.deviceIdEl) {
      this.options.deviceIdEl.textContent = deviceId.substring(0, 16) + '...';
      this.options.deviceIdEl.title = deviceId;
    }
    if (this.options.totalEventsEl) {
      this.options.totalEventsEl.textContent = String(metadata.totalEvents);
    }
    if (this.options.insertEventsEl) {
      this.options.insertEventsEl.textContent = String(metadata.insertEvents);
    }
    if (this.options.deleteEventsEl) {
      this.options.deleteEventsEl.textContent = String(metadata.deleteEvents);
    }
    if (this.options.typingTimeEl) {
      this.options.typingTimeEl.textContent = (metadata.totalTypingTime / 1000).toFixed(2) + '秒';
    }
    if (this.options.typingSpeedEl) {
      this.options.typingSpeedEl.textContent = metadata.averageTypingSpeed + ' WPM';
    }
  }

  /**
   * Pure Typingバッジをレンダリング
   */
  private renderPureTypingBadge(proofData: PanelRenderContext['proofData'], isPureTyping: boolean): void {
    if (isPureTyping) {
      if (this.options.pureTypingBadgeEl) {
        this.options.pureTypingBadgeEl.innerHTML = '✅ 純粋なタイピング';
        this.options.pureTypingBadgeEl.className = 'badge success';
      }
      if (this.options.pasteInfoEl) {
        this.options.pasteInfoEl.textContent = 'コピー&ペーストは検出されませんでした';
      }
      if (this.options.externalInputPreviewEl) {
        this.options.externalInputPreviewEl.style.display = 'none';
      }
    } else {
      if (this.options.pureTypingBadgeEl) {
        this.options.pureTypingBadgeEl.innerHTML = '⚠️ 外部入力あり';
        this.options.pureTypingBadgeEl.className = 'badge warning';
      }

      const pasteCount = proofData.typingProofData?.metadata.pasteEvents ?? 0;
      const dropCount = proofData.typingProofData?.metadata.dropEvents ?? 0;
      if (this.options.pasteInfoEl) {
        this.options.pasteInfoEl.textContent = `ペースト: ${pasteCount}回、ドロップ: ${dropCount}回`;
      }
    }
  }

  /**
   * 外部入力イベントをレンダリング
   */
  private renderExternalInputs(events: StoredEvent[]): void {
    const externalInputEvents = events.filter(event =>
      event.inputType === 'insertFromPaste' || event.inputType === 'insertFromDrop'
    );

    if (externalInputEvents.length === 0) {
      if (this.options.externalInputPreviewEl) {
        this.options.externalInputPreviewEl.style.display = 'none';
      }
      return;
    }

    if (this.options.externalInputPreviewEl) {
      this.options.externalInputPreviewEl.style.display = 'block';
    }
    if (this.options.externalInputListEl) {
      this.options.externalInputListEl.innerHTML = '';

      externalInputEvents.forEach((event) => {
        const eventDiv = document.createElement('div');
        eventDiv.className = 'external-input-item';

        const typeSpan = document.createElement('span');
        typeSpan.className = 'external-input-type';
        typeSpan.textContent = event.inputType === 'insertFromPaste' ? '📋 ペースト' : '📂 ドロップ';
        eventDiv.appendChild(typeSpan);

        const timeSpan = document.createElement('span');
        timeSpan.className = 'external-input-time';
        timeSpan.textContent = `${(event.timestamp / 1000).toFixed(2)}秒`;
        eventDiv.appendChild(timeSpan);

        const contentDiv = document.createElement('div');
        contentDiv.className = 'external-input-content';

        const content = typeof event.data === 'string' ? event.data : '';
        const maxLength = 200;
        const preview = content.length > maxLength
          ? content.substring(0, maxLength) + '...'
          : content;

        contentDiv.textContent = preview;
        contentDiv.title = content;
        eventDiv.appendChild(contentDiv);

        this.options.externalInputListEl!.appendChild(eventDiv);
      });
    }
  }

  /**
   * コンテンツプレビューをレンダリング
   */
  private renderContentPreview(content: string | undefined): void {
    if (!content || !this.options.contentPreviewEl) return;

    const lines = content.split('\n');
    const preview = lines.slice(0, 20).join('\n');
    this.options.contentPreviewEl.textContent = preview + (lines.length > 20 ? '\n...' : '');
  }

  clear(): void {
    // 基本メタデータ
    if (this.options.versionEl) this.options.versionEl.textContent = '';
    if (this.options.languageEl) this.options.languageEl.textContent = '';
    if (this.options.timestampEl) this.options.timestampEl.textContent = '';
    if (this.options.userAgentEl) this.options.userAgentEl.textContent = '';

    // タイピング統計
    if (this.options.deviceIdEl) this.options.deviceIdEl.textContent = '';
    if (this.options.totalEventsEl) this.options.totalEventsEl.textContent = '';
    if (this.options.insertEventsEl) this.options.insertEventsEl.textContent = '';
    if (this.options.deleteEventsEl) this.options.deleteEventsEl.textContent = '';
    if (this.options.typingTimeEl) this.options.typingTimeEl.textContent = '';
    if (this.options.typingSpeedEl) this.options.typingSpeedEl.textContent = '';

    // Pure Typing バッジ
    if (this.options.pureTypingBadgeEl) {
      this.options.pureTypingBadgeEl.innerHTML = '';
      this.options.pureTypingBadgeEl.className = 'badge';
    }
    if (this.options.pasteInfoEl) this.options.pasteInfoEl.textContent = '';

    // 外部入力
    if (this.options.externalInputPreviewEl) {
      this.options.externalInputPreviewEl.style.display = 'none';
    }
    if (this.options.externalInputListEl) {
      this.options.externalInputListEl.innerHTML = '';
    }

    // コンテンツプレビュー
    if (this.options.contentPreviewEl) this.options.contentPreviewEl.textContent = '';
  }

  setVisible(visible: boolean): void {
    // このパネルは複数のセクションにまたがるため、個別の表示制御は親で行う
  }
}
