/**
 * LogViewer - 操作ログを表示する読み取り専用ビューア
 */

import type { TypingProof } from '@typedcode/shared';
import type {
  StoredEvent,
  LogStats,
  EventType,
  InputType,
} from '@typedcode/shared';

/** 同種イベントのグループ化（フォーカス変更など） */
const SAME_TYPE_GROUPABLE: EventType[] = [
  'visibilityChange',
  'focusChange',
];

/** キー入力グループ（keyDown, keyUp, contentChange, cursorPositionChange, selectionChange を1つにまとめる） */
const KEY_INPUT_GROUP_TYPES: EventType[] = [
  'keyDown',
  'keyUp',
  'contentChange',
  'cursorPositionChange',
  'selectionChange',
];

/** マウス操作グループ（mousePositionChange, cursorPositionChange, selectionChange を1つにまとめる） */
const MOUSE_INPUT_GROUP_TYPES: EventType[] = [
  'mousePositionChange',
  'cursorPositionChange',
  'selectionChange',
];

/** キー入力グループの種類 */
type KeyInputGroupKind = 'normal' | 'enter' | 'delete';

/** グループ化されたエントリの情報 */
interface GroupedEntry {
  element: HTMLElement;
  groupType: 'sameType' | 'keyInput' | 'mouseInput';
  eventType: EventType;  // 代表イベントタイプ
  count: number;
  subCounts: Record<string, number>;  // サブカウント（keyDown: 1, keyUp: 1, contentChange: 1 など）
  lastEvent: StoredEvent;
  firstIndex: number;
  lastIndex: number;
  keyInputKind?: KeyInputGroupKind;  // キー入力グループの種類
}

export class LogViewer {
  private container: HTMLElement;
  private typingProof: TypingProof;
  isVisible: boolean = false;
  private autoScroll: boolean = true;

  // グループ化用の状態
  private lastGroupedEntry: GroupedEntry | null = null;

  constructor(containerElement: HTMLElement, typingProof: TypingProof) {
    this.container = containerElement;
    this.typingProof = typingProof;
  }

  /**
   * TypingProofインスタンスを切り替え（タブ切り替え時に使用）
   */
  setTypingProof(typingProof: TypingProof): void {
    this.typingProof = typingProof;
    this.lastGroupedEntry = null;
    if (this.isVisible) {
      this.refreshLogs();
    }
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
   * ログを全て再描画（グループ化対応）
   */
  refreshLogs(): void {
    const events = this.typingProof.events;
    this.container.innerHTML = '';
    this.lastGroupedEntry = null;

    events.forEach((event, index) => {
      this.addLogEntry(event, index);
    });

    if (this.autoScroll) {
      this.scrollToBottom();
    }
  }

  /**
   * 同種イベントのグループ化対象かチェック
   */
  private isSameTypeGroupable(event: StoredEvent): boolean {
    return SAME_TYPE_GROUPABLE.includes(event.type);
  }

  /**
   * イベントからキー名を取得
   */
  private getKeyFromEvent(event: StoredEvent): string | null {
    if ((event.type === 'keyDown' || event.type === 'keyUp') &&
        event.data && typeof event.data === 'object' && 'key' in event.data) {
      return event.data.key as string;
    }
    return null;
  }

  /**
   * キー入力グループの種類を判定
   */
  private getKeyInputKind(event: StoredEvent): KeyInputGroupKind {
    const key = this.getKeyFromEvent(event);
    if (key === 'Enter') return 'enter';
    if (key === 'Delete' || key === 'Backspace') return 'delete';
    return 'normal';
  }

  /**
   * キー入力グループの対象かチェック
   */
  private isKeyInputGroupable(event: StoredEvent): boolean {
    return KEY_INPUT_GROUP_TYPES.includes(event.type);
  }

  /**
   * マウス操作グループの対象かチェック
   */
  private isMouseInputGroupable(event: StoredEvent): boolean {
    return MOUSE_INPUT_GROUP_TYPES.includes(event.type);
  }

  /**
   * 最後のグループに追加可能かチェック
   */
  private canGroupWithLast(event: StoredEvent): boolean {
    if (!this.lastGroupedEntry) return false;

    if (this.lastGroupedEntry.groupType === 'sameType') {
      return this.isSameTypeGroupable(event) &&
             this.lastGroupedEntry.eventType === event.type;
    } else if (this.lastGroupedEntry.groupType === 'keyInput') {
      // キー入力グループの場合、種類（normal/enter/delete）が一致するかチェック
      if (!this.isKeyInputGroupable(event)) return false;
      const eventKind = this.getKeyInputKind(event);
      const groupKind = this.lastGroupedEntry.keyInputKind ?? 'normal';

      // Enter/Deleteグループの場合、cursorPositionChangeとselectionChangeも含める
      if (groupKind === 'enter' || groupKind === 'delete') {
        // カーソル移動・選択変更は常に受け入れる
        if (event.type === 'cursorPositionChange' || event.type === 'selectionChange') {
          return true;
        }
        // contentChangeも受け入れる（削除結果の反映）
        if (event.type === 'contentChange') {
          return true;
        }
        // keyDown/keyUpは同じ種類のみ
        return eventKind === groupKind;
      }

      // 通常のキー入力グループ
      return eventKind === groupKind;
    } else if (this.lastGroupedEntry.groupType === 'mouseInput') {
      return this.isMouseInputGroupable(event);
    }
    return false;
  }

  /**
   * 新しいログエントリを追加（グループ化対応）
   */
  addLogEntry(event: StoredEvent, index: number): void {
    // グループに追加可能かチェック
    if (this.canGroupWithLast(event)) {
      this.updateGroupedEntry(event, index);
      return;
    }

    // 同種イベントのグループ化
    if (this.isSameTypeGroupable(event)) {
      this.lastGroupedEntry = null;
      const entry = this.createSameTypeGroupEntry(event, index);
      this.container.appendChild(entry);
      this.lastGroupedEntry = {
        element: entry,
        groupType: 'sameType',
        eventType: event.type,
        count: 1,
        subCounts: { [event.type]: 1 },
        lastEvent: event,
        firstIndex: index,
        lastIndex: index,
      };
    }
    // キー入力グループ化
    else if (this.isKeyInputGroupable(event)) {
      this.lastGroupedEntry = null;
      const keyInputKind = this.getKeyInputKind(event);
      const entry = this.createKeyInputGroupEntry(event, index, keyInputKind);
      this.container.appendChild(entry);
      this.lastGroupedEntry = {
        element: entry,
        groupType: 'keyInput',
        eventType: 'contentChange',  // 代表タイプ
        count: 1,
        subCounts: { [event.type]: 1 },
        lastEvent: event,
        firstIndex: index,
        lastIndex: index,
        keyInputKind,
      };
    }
    // マウス操作グループ化
    else if (this.isMouseInputGroupable(event)) {
      this.lastGroupedEntry = null;
      const entry = this.createMouseInputGroupEntry(event, index);
      this.container.appendChild(entry);
      this.lastGroupedEntry = {
        element: entry,
        groupType: 'mouseInput',
        eventType: 'mousePositionChange',  // 代表タイプ
        count: 1,
        subCounts: { [event.type]: 1 },
        lastEvent: event,
        firstIndex: index,
        lastIndex: index,
      };
    }
    // グループ化しないイベント
    else {
      this.lastGroupedEntry = null;
      const entry = this.createLogEntry(event, index);
      this.container.appendChild(entry);
    }

    if (this.autoScroll) {
      this.scrollToBottom();
    }
  }

  /**
   * グループ化エントリを更新
   */
  private updateGroupedEntry(event: StoredEvent, index: number): void {
    if (!this.lastGroupedEntry) return;

    this.lastGroupedEntry.count++;
    this.lastGroupedEntry.subCounts[event.type] =
      (this.lastGroupedEntry.subCounts[event.type] ?? 0) + 1;
    this.lastGroupedEntry.lastEvent = event;
    this.lastGroupedEntry.lastIndex = index;

    const element = this.lastGroupedEntry.element;

    if (this.lastGroupedEntry.groupType === 'sameType') {
      // 同種イベント: カウントバッジを更新
      const badge = element.querySelector('.log-entry-count') as HTMLElement;
      if (badge) {
        badge.textContent = String(this.lastGroupedEntry.count);
      }
    } else if (this.lastGroupedEntry.groupType === 'keyInput') {
      // キー入力グループ: サブカウントを更新
      this.updateKeyInputSubCounts(element);
    } else if (this.lastGroupedEntry.groupType === 'mouseInput') {
      // マウス操作グループ: サブカウントを更新
      this.updateMouseInputSubCounts(element);
    }

    // タイムスタンプを最新に更新
    const timeEl = element.querySelector('.log-entry-time') as HTMLElement;
    if (timeEl) {
      timeEl.textContent = `${(event.timestamp / 1000).toFixed(2)}s`;
    }

    // インデックス範囲を更新
    const indexEl = element.querySelector('.log-entry-index') as HTMLElement;
    if (indexEl && this.lastGroupedEntry.firstIndex !== this.lastGroupedEntry.lastIndex) {
      indexEl.textContent = `#${this.lastGroupedEntry.firstIndex + 1}-${index + 1}`;
    }

    // キー入力グループの場合、contentChangeのデータを表示
    if (this.lastGroupedEntry.groupType === 'keyInput' && event.type === 'contentChange') {
      this.updateKeyInputDetails(element, event);
    }

    if (this.autoScroll) {
      this.scrollToBottom();
    }
  }

  /**
   * キー入力グループのサブカウント表示を更新
   */
  private updateKeyInputSubCounts(element: HTMLElement): void {
    if (!this.lastGroupedEntry) return;

    const subCountsEl = element.querySelector('.log-entry-subcounts') as HTMLElement;
    if (subCountsEl) {
      const parts: string[] = [];
      const { subCounts } = this.lastGroupedEntry;

      if (subCounts['keyDown']) parts.push(`↓${subCounts['keyDown']}`);
      if (subCounts['keyUp']) parts.push(`↑${subCounts['keyUp']}`);
      if (subCounts['contentChange']) parts.push(`✎${subCounts['contentChange']}`);
      if (subCounts['cursorPositionChange']) parts.push(`▸${subCounts['cursorPositionChange']}`);
      if (subCounts['selectionChange']) parts.push(`▬${subCounts['selectionChange']}`);

      subCountsEl.textContent = parts.join(' ');
    }
  }

  /**
   * マウス操作グループのサブカウント表示を更新
   */
  private updateMouseInputSubCounts(element: HTMLElement): void {
    if (!this.lastGroupedEntry) return;

    const subCountsEl = element.querySelector('.log-entry-subcounts') as HTMLElement;
    if (subCountsEl) {
      const parts: string[] = [];
      const { subCounts } = this.lastGroupedEntry;

      if (subCounts['mousePositionChange']) parts.push(`🖱${subCounts['mousePositionChange']}`);
      if (subCounts['cursorPositionChange']) parts.push(`▸${subCounts['cursorPositionChange']}`);
      if (subCounts['selectionChange']) parts.push(`▬${subCounts['selectionChange']}`);

      subCountsEl.textContent = parts.join(' ');
    }
  }

  /**
   * キー入力グループの詳細を更新
   */
  private updateKeyInputDetails(element: HTMLElement, event: StoredEvent): void {
    const detailsEl = element.querySelector('.log-entry-details') as HTMLElement;
    if (!detailsEl) return;

    const parts: string[] = [];

    // 入力データを表示
    if (event.data && typeof event.data === 'string') {
      parts.push(this.formatData(event.data));
    }

    // 詳細情報
    const details = this.getEventDetails(event);
    if (details) {
      parts.push(details);
    }

    if (parts.length > 0) {
      detailsEl.textContent = parts.join(' | ');
      detailsEl.style.display = '';
    }
  }

  /**
   * 同種イベントのグループエントリを作成
   */
  private createSameTypeGroupEntry(event: StoredEvent, index: number): HTMLElement {
    const entry = document.createElement('div');
    entry.className = `log-entry log-entry-grouped log-type-${event.type}`;

    // ヘッダー行
    const header = document.createElement('div');
    header.className = 'log-entry-header';

    const indexEl = document.createElement('span');
    indexEl.className = 'log-entry-index';
    indexEl.textContent = `#${index + 1}`;

    const timeEl = document.createElement('span');
    timeEl.className = 'log-entry-time';
    timeEl.textContent = `${(event.timestamp / 1000).toFixed(2)}s`;

    // カウントバッジ
    const countBadge = document.createElement('span');
    countBadge.className = 'log-entry-count';
    countBadge.textContent = '1';

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
    header.appendChild(countBadge);
    header.appendChild(infoContainer);

    entry.appendChild(header);

    // 詳細情報
    const details = this.getEventDetails(event);
    const detailsLine = document.createElement('div');
    detailsLine.className = 'log-entry-details';
    if (details) {
      detailsLine.textContent = details;
    } else {
      detailsLine.style.display = 'none';
    }
    entry.appendChild(detailsLine);

    return entry;
  }

  /**
   * キー入力グループのエントリを作成
   */
  private createKeyInputGroupEntry(event: StoredEvent, index: number, kind: KeyInputGroupKind = 'normal'): HTMLElement {
    const entry = document.createElement('div');

    // 種類に応じたクラスを設定
    let kindClass = 'log-entry-keyinput';
    if (kind === 'enter') kindClass = 'log-entry-enter';
    else if (kind === 'delete') kindClass = 'log-entry-delete';
    entry.className = `log-entry log-entry-grouped ${kindClass} log-type-contentChange`;

    // ヘッダー行
    const header = document.createElement('div');
    header.className = 'log-entry-header';

    const indexEl = document.createElement('span');
    indexEl.className = 'log-entry-index';
    indexEl.textContent = `#${index + 1}`;

    const timeEl = document.createElement('span');
    timeEl.className = 'log-entry-time';
    timeEl.textContent = `${(event.timestamp / 1000).toFixed(2)}s`;

    // サブカウント表示（↓1 ↑1 ✎1 ▸1 ▬1 のような形式）
    const subCountsEl = document.createElement('span');
    subCountsEl.className = 'log-entry-subcounts';
    const symbolMap: Record<string, string> = {
      keyDown: '↓',
      keyUp: '↑',
      contentChange: '✎',
      cursorPositionChange: '▸',
      selectionChange: '▬',
    };
    const symbol = symbolMap[event.type] ?? '?';
    subCountsEl.textContent = `${symbol}1`;

    const infoContainer = document.createElement('div');
    infoContainer.style.flex = '1';
    infoContainer.style.minWidth = '0';
    infoContainer.style.overflow = 'hidden';
    infoContainer.style.textOverflow = 'ellipsis';
    infoContainer.style.whiteSpace = 'nowrap';

    const typeEl = document.createElement('span');
    typeEl.className = 'log-entry-type';
    // 種類に応じたラベルを設定
    if (kind === 'enter') typeEl.textContent = 'Enter';
    else if (kind === 'delete') typeEl.textContent = '削除';
    else typeEl.textContent = 'キー入力';

    const descEl = document.createElement('span');
    descEl.className = 'log-entry-description';
    descEl.textContent = this.getKeyInputDescription(event);

    infoContainer.appendChild(typeEl);
    infoContainer.appendChild(descEl);

    header.appendChild(indexEl);
    header.appendChild(timeEl);
    header.appendChild(subCountsEl);
    header.appendChild(infoContainer);

    entry.appendChild(header);

    // 詳細情報
    const detailsLine = document.createElement('div');
    detailsLine.className = 'log-entry-details';

    if (event.type === 'contentChange' && event.data && typeof event.data === 'string') {
      detailsLine.textContent = this.formatData(event.data);
    } else {
      detailsLine.style.display = 'none';
    }
    entry.appendChild(detailsLine);

    return entry;
  }

  /**
   * マウス操作グループのエントリを作成
   */
  private createMouseInputGroupEntry(event: StoredEvent, index: number): HTMLElement {
    const entry = document.createElement('div');
    entry.className = 'log-entry log-entry-grouped log-entry-mouseinput log-type-mousePositionChange';

    // ヘッダー行
    const header = document.createElement('div');
    header.className = 'log-entry-header';

    const indexEl = document.createElement('span');
    indexEl.className = 'log-entry-index';
    indexEl.textContent = `#${index + 1}`;

    const timeEl = document.createElement('span');
    timeEl.className = 'log-entry-time';
    timeEl.textContent = `${(event.timestamp / 1000).toFixed(2)}s`;

    // サブカウント表示（🖱1 ▸1 ▬1 のような形式）
    const subCountsEl = document.createElement('span');
    subCountsEl.className = 'log-entry-subcounts';
    const symbolMap: Record<string, string> = {
      mousePositionChange: '🖱',
      cursorPositionChange: '▸',
      selectionChange: '▬',
    };
    const symbol = symbolMap[event.type] ?? '?';
    subCountsEl.textContent = `${symbol}1`;

    const infoContainer = document.createElement('div');
    infoContainer.style.flex = '1';
    infoContainer.style.minWidth = '0';
    infoContainer.style.overflow = 'hidden';
    infoContainer.style.textOverflow = 'ellipsis';
    infoContainer.style.whiteSpace = 'nowrap';

    const typeEl = document.createElement('span');
    typeEl.className = 'log-entry-type';
    typeEl.textContent = 'マウス操作';

    const descEl = document.createElement('span');
    descEl.className = 'log-entry-description';
    descEl.textContent = this.getMouseInputDescription(event);

    infoContainer.appendChild(typeEl);
    infoContainer.appendChild(descEl);

    header.appendChild(indexEl);
    header.appendChild(timeEl);
    header.appendChild(subCountsEl);
    header.appendChild(infoContainer);

    entry.appendChild(header);

    // 詳細情報
    const detailsLine = document.createElement('div');
    detailsLine.className = 'log-entry-details';
    detailsLine.style.display = 'none';
    entry.appendChild(detailsLine);

    return entry;
  }

  /**
   * マウス操作の説明を生成
   */
  private getMouseInputDescription(event: StoredEvent): string {
    if (event.type === 'selectionChange' && event.selectedText) {
      return '範囲選択';
    } else if (event.type === 'mousePositionChange') {
      return 'マウス移動';
    } else if (event.type === 'cursorPositionChange') {
      return 'カーソル移動';
    }
    return '';
  }

  /**
   * キー入力の説明を生成
   */
  private getKeyInputDescription(event: StoredEvent): string {
    if (event.type === 'contentChange') {
      return event.description ?? '文字入力';
    } else if (event.type === 'keyDown' || event.type === 'keyUp') {
      // KeystrokeDynamicsDataからキー情報を取得
      if (event.data && typeof event.data === 'object' && 'key' in event.data) {
        return `${event.data.key}`;
      }
    }
    return '';
  }

  /**
   * 通常のログエントリを作成
   */
  private createLogEntry(event: StoredEvent, index: number): HTMLElement {
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

    return entry;
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
