/**
 * DownloadDropdown - ダウンロードドロップダウンメニューの管理
 * ダウンロードボタンとドロップダウンメニューの表示/非表示を制御
 */

export interface DownloadDropdownOptions {
  buttonId: string;
  dropdownId: string;
}

export type HasTabsCallback = () => boolean;

export class DownloadDropdown {
  private button: HTMLElement | null = null;
  private dropdown: HTMLElement | null = null;
  private boundHandleOutsideClick: (e: MouseEvent) => void;
  private hasTabsCallback: HasTabsCallback | null = null;

  constructor() {
    this.boundHandleOutsideClick = this.handleOutsideClick.bind(this);
  }

  /**
   * DOM要素を初期化
   */
  initialize(options: DownloadDropdownOptions): boolean {
    this.button = document.getElementById(options.buttonId);
    this.dropdown = document.getElementById(options.dropdownId);

    if (!this.button || !this.dropdown) {
      console.warn('[DownloadDropdown] Required elements not found');
      return false;
    }

    this.attach();
    return true;
  }

  /**
   * タブ存在確認コールバックを設定
   */
  setHasTabsCallback(callback: HasTabsCallback): void {
    this.hasTabsCallback = callback;
  }

  /**
   * イベントリスナーをアタッチ
   */
  private attach(): void {
    if (!this.button || !this.dropdown) return;

    this.button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });

    document.addEventListener('click', this.boundHandleOutsideClick);
  }

  /**
   * 外側クリックでドロップダウンを閉じる
   */
  private handleOutsideClick(e: MouseEvent): void {
    if (!this.dropdown || !this.button) return;

    const target = e.target as Node;
    if (!this.dropdown.contains(target) && !this.button.contains(target)) {
      this.close();
    }
  }

  /**
   * ドロップダウンを開く
   */
  open(): void {
    this.updateItemsState();
    this.dropdown?.classList.add('visible');
  }

  /**
   * ドロップダウンを閉じる
   */
  close(): void {
    this.dropdown?.classList.remove('visible');
  }

  /**
   * ドロップダウンの表示/非表示を切り替え
   */
  toggle(): void {
    if (this.isVisible) {
      this.close();
    } else {
      this.open();
    }
  }

  /**
   * ドロップダウンが表示されているかを取得
   */
  get isVisible(): boolean {
    return this.dropdown?.classList.contains('visible') ?? false;
  }

  /**
   * ドロップダウン内のアイテムの有効/無効状態を更新
   */
  private updateItemsState(): void {
    if (!this.dropdown) return;

    const hasTabs = this.hasTabsCallback?.() ?? true;
    const items = this.dropdown.querySelectorAll('.dropdown-item');

    items.forEach((item) => {
      if (hasTabs) {
        item.classList.remove('disabled');
        item.removeAttribute('aria-disabled');
      } else {
        item.classList.add('disabled');
        item.setAttribute('aria-disabled', 'true');
      }
    });
  }

  /**
   * リソースを解放
   */
  dispose(): void {
    document.removeEventListener('click', this.boundHandleOutsideClick);
    this.button = null;
    this.dropdown = null;
    this.hasTabsCallback = null;
  }
}
