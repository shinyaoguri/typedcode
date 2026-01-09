/**
 * TerminalPanel - ターミナルパネルの表示/非表示制御
 * ターミナルパネルのトグル、閉じるボタン、リサイズを管理
 */

export interface TerminalPanelOptions {
  panelId: string;
  toggleButtonId: string;
  closeButtonId: string;
  resetButtonId?: string;
  resizeHandleId?: string;
  workbenchUpperSelector?: string;
  workbenchSelector?: string;
  onVisibilityChange?: (visible: boolean) => void;
  onFit?: () => void;
  onResetRuntime?: () => Promise<void>;
}

export class TerminalPanel {
  private panel: HTMLElement | null = null;
  private toggleButton: HTMLElement | null = null;
  private closeButton: HTMLElement | null = null;
  private resetButton: HTMLElement | null = null;
  private resizeHandle: HTMLElement | null = null;
  private workbenchUpperEl: HTMLElement | null = null;
  private workbenchSelector: string | null = null;
  private onVisibilityChange: ((visible: boolean) => void) | null = null;
  private onFit: (() => void) | null = null;
  private onResetRuntime: (() => Promise<void>) | null = null;
  private initialized = false;
  private _isTerminalAvailable = true;

  // リサイズ状態
  private isResizing = false;
  private startY = 0;
  private startHeight = 0;

  // バインドされたイベントハンドラ
  private boundMouseMove: ((e: MouseEvent) => void) | null = null;
  private boundMouseUp: (() => void) | null = null;

  /**
   * DOM要素を初期化
   */
  initialize(options: TerminalPanelOptions): boolean {
    this.panel = document.getElementById(options.panelId);
    this.toggleButton = document.getElementById(options.toggleButtonId);
    this.closeButton = document.getElementById(options.closeButtonId);
    if (options.resetButtonId) {
      this.resetButton = document.getElementById(options.resetButtonId);
    }
    this.onVisibilityChange = options.onVisibilityChange ?? null;
    this.onFit = options.onFit ?? null;
    this.onResetRuntime = options.onResetRuntime ?? null;

    // リサイズ関連
    if (options.resizeHandleId) {
      this.resizeHandle = document.getElementById(options.resizeHandleId);
    }
    if (options.workbenchUpperSelector) {
      this.workbenchUpperEl = document.querySelector(options.workbenchUpperSelector);
    }
    this.workbenchSelector = options.workbenchSelector ?? null;

    if (!this.panel) {
      console.warn('[TerminalPanel] Panel element not found');
      return false;
    }

    this.attach();
    this.setupResize();
    this.initialized = true;
    return true;
  }

  /**
   * イベントリスナーをアタッチ
   */
  private attach(): void {
    if (this.toggleButton && this.panel) {
      this.toggleButton.addEventListener('click', () => {
        this.toggle();
      });
    }

    if (this.closeButton && this.panel) {
      this.closeButton.addEventListener('click', () => {
        this.hide();
      });
    }

    if (this.resetButton && this.onResetRuntime) {
      this.resetButton.addEventListener('click', () => {
        this.onResetRuntime?.();
      });
    }
  }

  /**
   * リサイズ機能をセットアップ
   */
  private setupResize(): void {
    if (!this.resizeHandle || !this.panel || !this.workbenchUpperEl) {
      return;
    }

    this.boundMouseMove = this.handleMouseMove.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);

    this.resizeHandle.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
      this.isResizing = true;
      this.startY = e.clientY;
      this.startHeight = this.panel!.offsetHeight;

      this.panel!.classList.add('resizing');
      this.workbenchUpperEl!.classList.add('resizing');
      this.resizeHandle!.classList.add('dragging');

      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', this.boundMouseMove);
    document.addEventListener('mouseup', this.boundMouseUp);
  }

  /**
   * マウス移動ハンドラ
   */
  private handleMouseMove(e: MouseEvent): void {
    if (!this.isResizing || !this.panel) return;

    const workbenchEl = this.workbenchSelector
      ? document.querySelector(this.workbenchSelector) as HTMLElement | null
      : null;
    if (!workbenchEl) return;

    const workbenchHeight = workbenchEl.clientHeight;
    const deltaY = this.startY - e.clientY;
    const newHeight = this.startHeight + deltaY;

    // 最小高さ100px、最大高さは画面の60%
    const minHeight = 100;
    const maxHeight = workbenchHeight * 0.6;
    const clampedHeight = Math.max(minHeight, Math.min(maxHeight, newHeight));

    this.panel.style.height = `${clampedHeight}px`;
    this.onFit?.();
  }

  /**
   * マウスアップハンドラ
   */
  private handleMouseUp(): void {
    if (!this.isResizing) return;

    this.isResizing = false;

    this.panel?.classList.remove('resizing');
    this.workbenchUpperEl?.classList.remove('resizing');
    this.resizeHandle?.classList.remove('dragging');

    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  /**
   * ボタン状態を更新
   */
  private updateButtonState(): void {
    if (this.isVisible) {
      this.toggleButton?.classList.add('active');
    } else {
      this.toggleButton?.classList.remove('active');
    }
  }

  /**
   * パネルを表示
   */
  show(): void {
    if (!this.panel) return;
    this.panel.classList.add('visible');
    this.updateButtonState();
    this.onVisibilityChange?.(true);
    this.onFit?.();
  }

  /**
   * パネルを非表示
   */
  hide(): void {
    if (!this.panel) return;
    this.panel.classList.remove('visible');
    this.updateButtonState();
    this.onVisibilityChange?.(false);
  }

  /**
   * パネルの表示/非表示を切り替え
   */
  toggle(): void {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }

  /**
   * パネルが表示されているかを取得
   */
  get isVisible(): boolean {
    return this.panel?.classList.contains('visible') ?? false;
  }

  /**
   * ターミナルが利用可能かどうかを取得
   */
  get isTerminalAvailable(): boolean {
    return this._isTerminalAvailable;
  }

  /**
   * ターミナルの利用可否を設定
   * 利用不可の場合、パネルに 'terminal-unavailable' クラスを追加
   */
  setTerminalAvailable(available: boolean): void {
    this._isTerminalAvailable = available;
    if (this.panel) {
      if (available) {
        this.panel.classList.remove('terminal-unavailable');
      } else {
        this.panel.classList.add('terminal-unavailable');
      }
    }
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
    this.panel = null;
    this.toggleButton = null;
    this.closeButton = null;
    this.resetButton = null;
    this.resizeHandle = null;
    this.workbenchUpperEl = null;
    this.onVisibilityChange = null;
    this.onFit = null;
    this.onResetRuntime = null;
    this.initialized = false;
  }
}
