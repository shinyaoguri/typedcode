/**
 * BrowserPreviewPanel - ブラウザプレビューパネルの表示・リサイズ制御
 * HTML/CSS/JSタブを統合してiframeでプレビュー表示
 */

import type { TabManager, TabState } from '../tabs/TabManager.js';
import type * as monaco from 'monaco-editor';

export interface BrowserPreviewPanelOptions {
  /** パネルID */
  panelId: string;
  /** トグルボタンID */
  toggleButtonId: string;
  /** 閉じるボタンID */
  closeButtonId: string;
  /** 更新ボタンID */
  refreshButtonId: string;
  /** リサイズハンドルID */
  resizeHandleId: string;
  /** エディタコンテナ要素 */
  editorContainer: HTMLElement;
  /** TabManagerを取得するゲッター */
  getTabManager: () => TabManager | null;
}

export class BrowserPreviewPanel {
  private options: BrowserPreviewPanelOptions | null = null;
  private panelEl: HTMLElement | null = null;
  private toggleBtn: HTMLElement | null = null;
  private closeBtn: HTMLElement | null = null;
  private refreshBtn: HTMLElement | null = null;
  private resizeHandle: HTMLElement | null = null;
  private iframe: HTMLIFrameElement | null = null;
  private placeholder: HTMLElement | null = null;
  private filenameEl: HTMLElement | null = null;
  private editorContainer: HTMLElement | null = null;
  private mainEl: HTMLElement | null = null;

  // 表示状態
  private _isVisible = false;

  // リサイズ状態
  private isResizing = false;
  private startX = 0;
  private startWidth = 0;

  // バインドされたイベントハンドラ
  private boundMouseMove: ((e: MouseEvent) => void) | null = null;
  private boundMouseUp: (() => void) | null = null;

  // デバウンス
  private updateDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEBOUNCE_MS = 300;

  // スクロール位置保存
  private lastScrollPosition = { x: 0, y: 0 };

  // Monacoモデル変更リスナーのdispose関数
  private modelChangeDisposables: monaco.IDisposable[] = [];

  /**
   * パネルを初期化
   */
  initialize(options: BrowserPreviewPanelOptions): boolean {
    this.options = options;
    this.editorContainer = options.editorContainer;

    // DOM要素を取得
    this.panelEl = document.getElementById(options.panelId);
    this.toggleBtn = document.getElementById(options.toggleButtonId);
    this.closeBtn = document.getElementById(options.closeButtonId);
    this.refreshBtn = document.getElementById(options.refreshButtonId);
    this.resizeHandle = document.getElementById(options.resizeHandleId);
    this.iframe = document.getElementById('preview-iframe') as HTMLIFrameElement;
    this.placeholder = document.getElementById('preview-placeholder');
    this.filenameEl = document.getElementById('preview-filename');
    this.mainEl = document.querySelector('main');

    if (!this.panelEl) {
      console.error('[BrowserPreviewPanel] Panel element not found');
      return false;
    }

    // イベントリスナーを設定
    this.setupToggleButton();
    this.setupCloseButton();
    this.setupRefreshButton();
    this.setupResizeHandle();
    this.setupContentObserver();

    console.log('[BrowserPreviewPanel] Initialized');
    return true;
  }

  /**
   * 表示状態を取得
   */
  get isVisible(): boolean {
    return this._isVisible;
  }

  /**
   * トグルボタンのセットアップ
   */
  private setupToggleButton(): void {
    if (this.toggleBtn) {
      this.toggleBtn.addEventListener('click', () => {
        this.toggle();
      });
    }
  }

  /**
   * 閉じるボタンのセットアップ
   */
  private setupCloseButton(): void {
    if (this.closeBtn) {
      this.closeBtn.addEventListener('click', () => {
        this.hide();
      });
    }
  }

  /**
   * 更新ボタンのセットアップ
   */
  private setupRefreshButton(): void {
    if (this.refreshBtn) {
      this.refreshBtn.addEventListener('click', () => {
        this.refresh();
      });
    }
  }

  /**
   * トグルボタンの状態を更新
   */
  private updateToggleButtonState(): void {
    if (this._isVisible) {
      this.toggleBtn?.classList.add('active');
    } else {
      this.toggleBtn?.classList.remove('active');
    }
  }

  /**
   * パネルを表示
   */
  show(): void {
    if (!this.panelEl) return;

    this._isVisible = true;
    this.panelEl.classList.add('visible');
    this.editorContainer?.classList.add('with-preview');
    this.updateToggleButtonState();
    this.refresh();
  }

  /**
   * パネルを非表示
   */
  hide(): void {
    if (!this.panelEl) return;

    this._isVisible = false;
    this.panelEl.classList.remove('visible');
    this.editorContainer?.classList.remove('with-preview');

    // リサイズで設定されたインラインスタイルをクリア
    this.panelEl.style.flex = '';
    this.panelEl.style.minWidth = '';

    this.updateToggleButtonState();
  }

  /**
   * パネルをトグル
   */
  toggle(): void {
    if (this._isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }

  /**
   * プレビューを更新
   */
  refresh(): void {
    if (!this._isVisible) return;

    const result = this.generatePreviewContent();

    if (!result) {
      // HTMLファイルがない場合はプレースホルダーを表示
      this.showPlaceholder();
      this.updateFilename('');
      return;
    }

    this.hidePlaceholder();
    this.updateFilename(result.filename);
    this.setIframeContent(result.html);
  }

  /**
   * ヘッダーのファイル名を更新
   */
  private updateFilename(filename: string): void {
    if (this.filenameEl) {
      this.filenameEl.textContent = filename;
    }
  }

  /**
   * プレースホルダーを表示
   */
  private showPlaceholder(): void {
    if (this.iframe) {
      this.iframe.srcdoc = '';
      this.iframe.style.display = 'none';
    }
    if (this.placeholder) {
      this.placeholder.style.display = 'flex';
    }
  }

  /**
   * プレースホルダーを非表示
   */
  private hidePlaceholder(): void {
    if (this.iframe) {
      this.iframe.style.display = 'block';
    }
    if (this.placeholder) {
      this.placeholder.style.display = 'none';
    }
  }

  // Blob URL管理
  private currentBlobUrl: string | null = null;

  /**
   * iframeにコンテンツを設定
   */
  private setIframeContent(content: string): void {
    if (!this.iframe) return;

    // スクロール位置を保存
    this.saveScrollPosition();

    // 前のBlob URLを解放
    if (this.currentBlobUrl) {
      URL.revokeObjectURL(this.currentBlobUrl);
      this.currentBlobUrl = null;
    }

    // Blob URLを作成してiframeに設定
    const blob = new Blob([content], { type: 'text/html' });
    this.currentBlobUrl = URL.createObjectURL(blob);
    this.iframe.src = this.currentBlobUrl;

    // ロード後にスクロール位置を復元
    this.iframe.onload = () => {
      this.restoreScrollPosition();
    };
  }

  /**
   * スクロール位置を保存
   */
  private saveScrollPosition(): void {
    if (!this.iframe?.contentWindow) return;

    try {
      this.lastScrollPosition = {
        x: this.iframe.contentWindow.scrollX ?? 0,
        y: this.iframe.contentWindow.scrollY ?? 0,
      };
    } catch {
      // cross-origin制限でアクセスできない場合は無視
      this.lastScrollPosition = { x: 0, y: 0 };
    }
  }

  /**
   * スクロール位置を復元
   */
  private restoreScrollPosition(): void {
    if (!this.iframe?.contentWindow) return;

    try {
      this.iframe.contentWindow.scrollTo(
        this.lastScrollPosition.x,
        this.lastScrollPosition.y
      );
    } catch {
      // cross-origin制限でアクセスできない場合は無視
    }
  }

  /**
   * プレビューコンテンツを生成
   * @returns HTMLコンテンツとファイル名のオブジェクト、またはnull
   */
  private generatePreviewContent(): { html: string; filename: string } | null {
    const tabManager = this.options?.getTabManager();
    if (!tabManager) return null;

    const tabs = tabManager.getAllTabs();

    // HTMLタブを探す（アクティブタブ優先）
    const activeTab = tabManager.getActiveTab();
    let htmlTab: TabState | undefined;

    if (activeTab?.language === 'html') {
      htmlTab = activeTab;
    } else {
      htmlTab = tabs.find(t => t.language === 'html');
    }

    if (!htmlTab) return null;

    // HTMLを取得
    let html = htmlTab.model.getValue();

    // HTMLから参照されているCSS/JSファイルを解析
    const referencedCss = this.parseLinkedStylesheets(html);
    const referencedJs = this.parseLinkedScripts(html);

    // タブのファイル名マップを作成
    const tabMap = new Map<string, TabState>();
    for (const tab of tabs) {
      // 拡張子付きと拡張子なしの両方でマッピング
      tabMap.set(tab.filename, tab);
      const ext = tab.language === 'css' ? '.css' : tab.language === 'javascript' ? '.js' : '';
      if (ext) {
        tabMap.set(`${tab.filename}${ext}`, tab);
      }
    }

    // 参照されているCSSファイルをインライン化
    for (const cssRef of referencedCss) {
      const tab = this.findMatchingTab(cssRef, tabMap, 'css');
      if (tab) {
        const styleContent = `<style data-source="${this.escapeHtml(cssRef)}">\n${tab.model.getValue()}\n</style>`;
        // <link>タグを<style>タグに置換
        html = this.replaceLinkTag(html, cssRef, styleContent);
      }
    }

    // 参照されているJSファイルをインライン化
    for (const jsRef of referencedJs) {
      const tab = this.findMatchingTab(jsRef, tabMap, 'javascript');
      if (tab) {
        const scriptContent = `<script data-source="${this.escapeHtml(jsRef)}">\n${tab.model.getValue()}\n</script>`;
        // <script src>タグをインラインスクリプトに置換
        html = this.replaceScriptTag(html, jsRef, scriptContent);
      }
    }

    return { html, filename: `${htmlTab.filename}.html` };
  }

  /**
   * HTMLから<link rel="stylesheet" href="...">を解析
   */
  private parseLinkedStylesheets(html: string): string[] {
    const results: string[] = [];
    // <link rel="stylesheet" href="..."> または <link href="..." rel="stylesheet"> をマッチ
    const linkRegex = /<link\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
      const fullTag = match[0];
      const href = match[1];
      // rel="stylesheet" を含むかチェック
      if (/rel\s*=\s*["']stylesheet["']/i.test(fullTag)) {
        results.push(href);
      }
    }

    return results;
  }

  /**
   * HTMLから<script src="...">を解析
   */
  private parseLinkedScripts(html: string): string[] {
    const results: string[] = [];
    // <script src="..."> をマッチ（type="module"も含む）
    const scriptRegex = /<script\s+[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let match;

    while ((match = scriptRegex.exec(html)) !== null) {
      results.push(match[1]);
    }

    return results;
  }

  /**
   * 参照パスに一致するタブを探す
   */
  private findMatchingTab(
    refPath: string,
    tabMap: Map<string, TabState>,
    language: string
  ): TabState | undefined {
    // 直接マッチ
    if (tabMap.has(refPath)) {
      const tab = tabMap.get(refPath);
      if (tab?.language === language) return tab;
    }

    // ファイル名のみで検索（パスの最後の部分）
    const filename = refPath.split('/').pop() || refPath;
    if (tabMap.has(filename)) {
      const tab = tabMap.get(filename);
      if (tab?.language === language) return tab;
    }

    // 拡張子なしのファイル名で検索
    const filenameWithoutExt = filename.replace(/\.(css|js)$/, '');
    if (tabMap.has(filenameWithoutExt)) {
      const tab = tabMap.get(filenameWithoutExt);
      if (tab?.language === language) return tab;
    }

    return undefined;
  }

  /**
   * <link>タグを<style>タグに置換
   */
  private replaceLinkTag(html: string, href: string, replacement: string): string {
    // href属性をエスケープして正規表現を作成
    const escapedHref = href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const linkRegex = new RegExp(
      `<link\\s+[^>]*href\\s*=\\s*["']${escapedHref}["'][^>]*>`,
      'gi'
    );
    return html.replace(linkRegex, replacement);
  }

  /**
   * <script src>タグをインラインスクリプトに置換
   */
  private replaceScriptTag(html: string, src: string, replacement: string): string {
    // src属性をエスケープして正規表現を作成
    const escapedSrc = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // <script src="..."></script> または <script src="..." /> をマッチ
    const scriptRegex = new RegExp(
      `<script\\s+[^>]*src\\s*=\\s*["']${escapedSrc}["'][^>]*>\\s*</script>`,
      'gi'
    );
    return html.replace(scriptRegex, replacement);
  }

  /**
   * HTMLエスケープ
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * コンテンツ変更の監視をセットアップ
   */
  private setupContentObserver(): void {
    // 既存のリスナーをクリア
    this.disposeModelChangeListeners();

    const tabManager = this.options?.getTabManager();
    if (!tabManager) return;

    const tabs = tabManager.getAllTabs();
    for (const tab of tabs) {
      const disposable = tab.model.onDidChangeContent(() => {
        this.handleContentChange();
      });
      this.modelChangeDisposables.push(disposable);
    }
  }

  /**
   * コンテンツ変更ハンドラ（デバウンス付き）
   */
  private handleContentChange(): void {
    if (!this._isVisible) return;

    // 既存のタイマーをクリア
    if (this.updateDebounceTimer) {
      clearTimeout(this.updateDebounceTimer);
    }

    // デバウンスして更新
    this.updateDebounceTimer = setTimeout(() => {
      this.refresh();
    }, this.DEBOUNCE_MS);
  }

  /**
   * 新しいタブが追加された時に監視を更新
   */
  updateContentObserver(): void {
    this.setupContentObserver();
  }

  /**
   * リサイズハンドルのセットアップ
   */
  private setupResizeHandle(): void {
    if (!this.resizeHandle || !this.panelEl) {
      return;
    }

    // イベントハンドラをバインド
    this.boundMouseMove = this.handleResizeMouseMove.bind(this);
    this.boundMouseUp = this.handleResizeMouseUp.bind(this);

    this.resizeHandle.addEventListener('mousedown', (e: MouseEvent) => {
      // パネルが非表示の場合は何もしない
      if (!this._isVisible) return;

      e.preventDefault();

      this.isResizing = true;
      this.startX = e.clientX;
      this.startWidth = this.panelEl!.offsetWidth;

      // リサイズ中はトランジションを無効化
      this.panelEl!.classList.add('resizing');
      this.editorContainer?.classList.add('resizing');
      this.resizeHandle!.classList.add('dragging');

      // body全体でカーソルを変更
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    // グローバルなイベントリスナーを追加（初期化時に一度だけ）
    document.addEventListener('mousemove', this.boundMouseMove);
    document.addEventListener('mouseup', this.boundMouseUp);
  }

  /**
   * リサイズ中のマウス移動ハンドラ
   */
  private handleResizeMouseMove(e: MouseEvent): void {
    if (!this.isResizing || !this.panelEl) return;

    // workbench-upper の幅を基準にする
    const workbenchUpper = this.panelEl.parentElement;
    if (!workbenchUpper) return;

    const containerWidth = workbenchUpper.clientWidth;
    // パネルの左端にリサイズハンドルがあるため、
    // マウスを左に動かす(deltaX > 0) → パネルを大きく
    // マウスを右に動かす(deltaX < 0) → パネルを小さく
    const deltaX = this.startX - e.clientX;
    const newWidth = this.startWidth + deltaX;

    // 最小幅200px、最大幅はコンテナの60%
    const minWidth = 200;
    const maxWidth = containerWidth * 0.6;
    const clampedWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));

    // ピクセルで幅を設定
    this.panelEl.style.flex = `0 0 ${clampedWidth}px`;
    this.panelEl.style.minWidth = `${clampedWidth}px`;
  }

  /**
   * リサイズ終了時のマウスアップハンドラ
   */
  private handleResizeMouseUp(): void {
    if (!this.isResizing) return;

    this.isResizing = false;

    // トランジションを再有効化
    this.panelEl?.classList.remove('resizing');
    this.editorContainer?.classList.remove('resizing');
    this.resizeHandle?.classList.remove('dragging');

    // カーソルを元に戻す
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  /**
   * モデル変更リスナーを破棄
   */
  private disposeModelChangeListeners(): void {
    for (const disposable of this.modelChangeDisposables) {
      disposable.dispose();
    }
    this.modelChangeDisposables = [];
  }

  /**
   * リソースを解放
   */
  dispose(): void {
    // デバウンスタイマーをクリア
    if (this.updateDebounceTimer) {
      clearTimeout(this.updateDebounceTimer);
    }

    // Blob URLを解放
    if (this.currentBlobUrl) {
      URL.revokeObjectURL(this.currentBlobUrl);
      this.currentBlobUrl = null;
    }

    // モデル変更リスナーを破棄
    this.disposeModelChangeListeners();

    // グローバルイベントリスナーを削除
    if (this.boundMouseMove) {
      document.removeEventListener('mousemove', this.boundMouseMove);
    }
    if (this.boundMouseUp) {
      document.removeEventListener('mouseup', this.boundMouseUp);
    }

    // 参照をクリア
    this.options = null;
    this.panelEl = null;
    this.toggleBtn = null;
    this.closeBtn = null;
    this.refreshBtn = null;
    this.resizeHandle = null;
    this.iframe = null;
    this.placeholder = null;
    this.filenameEl = null;
    this.editorContainer = null;
    this.mainEl = null;
  }
}
