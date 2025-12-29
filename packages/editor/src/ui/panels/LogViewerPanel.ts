/**
 * LogViewerPanel - ログビューアパネルの表示・リサイズ制御
 * トグル、表示/非表示、リサイズ機能を管理
 */

import type { LogViewer } from '../components/LogViewer.js';

export interface LogViewerPanelOptions {
  /** LogViewerインスタンスを取得するゲッター */
  getLogViewer: () => LogViewer | null;
  /** エディタコンテナ要素 */
  editorContainer: HTMLElement;
  /** トグルボタンID */
  toggleButtonId: string;
  /** 閉じるボタンID */
  closeButtonId: string;
  /** クリアボタンID */
  clearButtonId: string;
  /** リサイズハンドルID */
  resizeHandleId: string;
  /** ログビューアパネルID */
  panelId: string;
  /** ステータスバーのイベントカウントセレクタ */
  eventCountSelector?: string;
}

export class LogViewerPanel {
  private getLogViewer: () => LogViewer | null;
  private editorContainer: HTMLElement;
  private toggleBtn: HTMLElement | null = null;
  private closeBtn: HTMLElement | null = null;
  private clearBtn: HTMLElement | null = null;
  private resizeHandle: HTMLElement | null = null;
  private panelEl: HTMLElement | null = null;
  private mainEl: HTMLElement | null = null;

  // リサイズ状態
  private isResizing = false;
  private startX = 0;
  private startWidth = 0;

  // バインドされたイベントハンドラ
  private boundMouseMove: ((e: MouseEvent) => void) | null = null;
  private boundMouseUp: (() => void) | null = null;

  constructor(options: LogViewerPanelOptions) {
    this.getLogViewer = options.getLogViewer;
    this.editorContainer = options.editorContainer;

    // DOM要素を取得
    this.toggleBtn = document.getElementById(options.toggleButtonId);
    this.closeBtn = document.getElementById(options.closeButtonId);
    this.clearBtn = document.getElementById(options.clearButtonId);
    this.resizeHandle = document.getElementById(options.resizeHandleId);
    this.panelEl = document.getElementById(options.panelId);
    this.mainEl = document.querySelector('main');

    // イベントリスナーを設定
    this.setupToggleButton();
    this.setupCloseButton();
    this.setupClearButton();
    this.setupResizeHandle();

    // ステータスバークリックでログ表示
    if (options.eventCountSelector) {
      this.setupEventCountClick(options.eventCountSelector);
    }
  }

  /**
   * トグルボタンの状態を更新
   */
  private updateToggleButtonState(): void {
    const logViewer = this.getLogViewer();
    if (logViewer?.isVisible) {
      this.toggleBtn?.classList.add('active');
    } else {
      this.toggleBtn?.classList.remove('active');
    }
  }

  /**
   * トグルボタンのセットアップ
   */
  private setupToggleButton(): void {
    if (this.toggleBtn) {
      this.toggleBtn.addEventListener('click', () => {
        console.log('[LogViewerPanel] Toggle button clicked');
        this.getLogViewer()?.toggle();
        this.updateToggleButtonState();
      });
      console.log('[LogViewerPanel] Toggle button listener added');
    } else {
      console.error('[LogViewerPanel] Toggle button not found');
    }
  }

  /**
   * 閉じるボタンのセットアップ
   */
  private setupCloseButton(): void {
    if (this.closeBtn) {
      this.closeBtn.addEventListener('click', () => {
        this.getLogViewer()?.hide();
        this.updateToggleButtonState();
      });
    }
  }

  /**
   * クリアボタンのセットアップ
   */
  private setupClearButton(): void {
    if (this.clearBtn) {
      this.clearBtn.addEventListener('click', () => {
        if (confirm('ログをクリアしますか？（証明データは保持されます）')) {
          this.getLogViewer()?.clear();
        }
      });
    }
  }

  /**
   * ステータスバーのイベントカウントクリックでログ表示
   */
  private setupEventCountClick(selector: string): void {
    const eventCountItem = document.querySelector(selector);
    if (eventCountItem) {
      (eventCountItem as HTMLElement).style.cursor = 'pointer';
      eventCountItem.addEventListener('click', () => {
        const logViewer = this.getLogViewer();
        if (!logViewer?.isVisible) {
          logViewer?.show();
          this.updateToggleButtonState();
        }
      });
    }
  }

  /**
   * リサイズハンドルのセットアップ
   */
  private setupResizeHandle(): void {
    if (!this.resizeHandle || !this.panelEl || !this.mainEl) {
      return;
    }

    // イベントハンドラをバインド
    this.boundMouseMove = this.handleMouseMove.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);

    this.resizeHandle.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
      this.isResizing = true;
      this.startX = e.clientX;
      this.startWidth = this.panelEl!.offsetWidth;

      // リサイズ中はトランジションを無効化
      this.panelEl!.classList.add('resizing');
      this.editorContainer.classList.add('resizing');
      this.resizeHandle!.classList.add('dragging');

      // body全体でカーソルを変更
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', this.boundMouseMove);
    document.addEventListener('mouseup', this.boundMouseUp);
  }

  /**
   * マウス移動ハンドラ
   */
  private handleMouseMove(e: MouseEvent): void {
    if (!this.isResizing || !this.panelEl || !this.mainEl) return;

    const mainWidth = this.mainEl.clientWidth;
    const deltaX = this.startX - e.clientX;
    const newWidth = this.startWidth + deltaX;

    // 最小幅200px、最大幅は画面の70%
    const minWidth = 200;
    const maxWidth = mainWidth * 0.7;
    const clampedWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));

    // パーセンテージを計算
    const widthPercent = (clampedWidth / mainWidth) * 100;

    // flexで幅を設定
    this.panelEl.style.flex = `0 0 ${widthPercent}%`;
    this.editorContainer.style.flex = `1 1 ${100 - widthPercent}%`;
  }

  /**
   * マウスアップハンドラ
   */
  private handleMouseUp(): void {
    if (!this.isResizing) return;

    this.isResizing = false;

    // トランジションを再有効化
    this.panelEl?.classList.remove('resizing');
    this.editorContainer.classList.remove('resizing');
    this.resizeHandle?.classList.remove('dragging');

    // カーソルを元に戻す
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  /**
   * ログビューアを表示
   */
  show(): void {
    this.getLogViewer()?.show();
    this.updateToggleButtonState();
  }

  /**
   * ログビューアを非表示
   */
  hide(): void {
    this.getLogViewer()?.hide();
    this.updateToggleButtonState();
  }

  /**
   * ログビューアをトグル
   */
  toggle(): void {
    this.getLogViewer()?.toggle();
    this.updateToggleButtonState();
  }

  /**
   * リソースを解放
   */
  dispose(): void {
    if (this.boundMouseMove) {
      document.removeEventListener('mousemove', this.boundMouseMove);
    }
    if (this.boundMouseUp) {
      document.removeEventListener('mouseup', this.boundMouseUp);
    }
    this.toggleBtn = null;
    this.closeBtn = null;
    this.clearBtn = null;
    this.resizeHandle = null;
    this.panelEl = null;
    this.mainEl = null;
  }
}
