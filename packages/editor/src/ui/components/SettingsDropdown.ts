/**
 * SettingsDropdown - 設定ドロップダウンメニューの管理
 * 設定ボタンとドロップダウンメニューの表示/非表示を制御
 */

export interface SettingsDropdownOptions {
  buttonId: string;
  dropdownId: string;
}

export class SettingsDropdown {
  private button: HTMLElement | null = null;
  private dropdown: HTMLElement | null = null;
  private boundHandleOutsideClick: (e: MouseEvent) => void;
  private initialized = false;

  constructor() {
    this.boundHandleOutsideClick = this.handleOutsideClick.bind(this);
  }

  /**
   * DOM要素を初期化
   */
  initialize(options: SettingsDropdownOptions): boolean {
    this.button = document.getElementById(options.buttonId);
    this.dropdown = document.getElementById(options.dropdownId);

    if (!this.button || !this.dropdown) {
      console.warn('[SettingsDropdown] Required elements not found');
      return false;
    }

    this.attach();
    this.initialized = true;
    return true;
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
    this.dropdown?.classList.toggle('visible');
  }

  /**
   * ドロップダウンが表示されているかを取得
   */
  get isVisible(): boolean {
    return this.dropdown?.classList.contains('visible') ?? false;
  }

  /**
   * リソースを解放
   */
  dispose(): void {
    document.removeEventListener('click', this.boundHandleOutsideClick);
    this.button = null;
    this.dropdown = null;
    this.initialized = false;
  }
}
