/**
 * MainMenuDropdown - メインメニュードロップダウンの管理
 * ハンバーガーメニューとドロップダウンの表示/非表示を制御
 */

export interface MainMenuDropdownOptions {
  buttonId: string;
  dropdownId: string;
}

export class MainMenuDropdown {
  private button: HTMLElement | null = null;
  private dropdown: HTMLElement | null = null;
  private boundHandleOutsideClick: (e: MouseEvent) => void;

  constructor() {
    this.boundHandleOutsideClick = this.handleOutsideClick.bind(this);
  }

  /**
   * DOM要素を初期化
   */
  initialize(options: MainMenuDropdownOptions): boolean {
    this.button = document.getElementById(options.buttonId);
    this.dropdown = document.getElementById(options.dropdownId);

    if (!this.button || !this.dropdown) {
      console.warn('[MainMenuDropdown] Required elements not found');
      return false;
    }

    this.attach();
    return true;
  }

  /**
   * イベントリスナーをアタッチ
   */
  private attach(): void {
    if (!this.button || !this.dropdown) return;

    // a11y (#743): popup を持つボタンであることと、その開閉を支援技術に伝える。開閉は下の open / close / toggle に
    // 集約し、aria-expanded は `visible` クラスと必ず一緒に変える (メニューの外から直接クラスを外さない)
    this.button.setAttribute('aria-haspopup', 'true');
    this.syncExpanded();

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
    this.syncExpanded();
  }

  /**
   * ドロップダウンを閉じる
   */
  close(): void {
    this.dropdown?.classList.remove('visible');
    this.syncExpanded();
  }

  /**
   * ドロップダウンの表示/非表示を切り替え
   */
  toggle(): void {
    this.dropdown?.classList.toggle('visible');
    this.syncExpanded();
  }

  /** ボタンの aria-expanded を表示状態に合わせる */
  private syncExpanded(): void {
    this.button?.setAttribute('aria-expanded', String(this.isVisible));
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
  }
}
