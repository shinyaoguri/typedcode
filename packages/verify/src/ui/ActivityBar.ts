/**
 * Activity Bar - Left icon bar with dropdown menus
 */

import { FileSystemAccessService } from '../services/FileSystemAccessService.js';
import { getI18n } from '../i18n/index.js';

export class ActivityBar {
  private mainMenuBtn: HTMLElement;
  private mainMenuDropdown: HTMLElement;
  private settingsBtn: HTMLElement;
  private settingsDropdown: HTMLElement;
  private openFileBtn: HTMLElement;
  private openFolderBtn: HTMLElement | null;
  private themeToggleBtn: HTMLElement;
  private languageToggleBtn: HTMLElement | null;
  private aboutBtn: HTMLElement | null;
  private explorerToggleBtn: HTMLElement;

  private onOpenFile: () => void;
  private onOpenFolder: () => void;
  private onThemeToggle: () => void;
  private onExplorerToggle: () => void;
  private onLanguageToggle: () => void;
  private onAbout: () => void;

  private explorerVisible = true;

  constructor(callbacks: {
    onOpenFile: () => void;
    onOpenFolder: () => void;
    onThemeToggle: () => void;
    onExplorerToggle?: () => void;
    onLanguageToggle?: () => void;
    onAbout?: () => void;
  }) {
    this.onOpenFile = callbacks.onOpenFile;
    this.onOpenFolder = callbacks.onOpenFolder;
    this.onThemeToggle = callbacks.onThemeToggle;
    this.onExplorerToggle = callbacks.onExplorerToggle ?? (() => {});
    this.onLanguageToggle = callbacks.onLanguageToggle ?? (() => {});
    this.onAbout = callbacks.onAbout ?? (() => {});

    this.mainMenuBtn = document.getElementById('main-menu-btn')!;
    this.mainMenuDropdown = document.getElementById('main-menu-dropdown')!;
    this.settingsBtn = document.getElementById('settings-btn')!;
    this.settingsDropdown = document.getElementById('settings-dropdown')!;
    this.openFileBtn = document.getElementById('open-file-btn')!;
    this.openFolderBtn = document.getElementById('open-folder-btn');
    this.themeToggleBtn = document.getElementById('theme-toggle-btn')!;
    this.languageToggleBtn = document.getElementById('language-toggle-btn');
    this.aboutBtn = document.getElementById('about-btn');
    this.explorerToggleBtn = document.getElementById('explorer-toggle-btn')!;

    // フォルダを開くボタンを動的に追加（存在しない場合）
    if (!this.openFolderBtn) {
      this.createOpenFolderButton();
    }

    // 現在の言語ラベルを更新
    this.updateLanguageLabel();

    this.setupEventListeners();
  }

  /**
   * フォルダを開くボタンを動的に追加
   */
  private createOpenFolderButton(): void {
    // File System Access API がサポートされていない場合はボタンを追加しない
    if (!FileSystemAccessService.isSupported()) {
      return;
    }

    const openFolderBtn = document.createElement('button');
    openFolderBtn.id = 'open-folder-btn';
    openFolderBtn.className = 'dropdown-item';
    openFolderBtn.innerHTML = `
      <i class="fas fa-folder-tree"></i>
      <span>フォルダを開く</span>
    `;

    // open-file-btn の後に挿入
    this.openFileBtn.insertAdjacentElement('afterend', openFolderBtn);
    this.openFolderBtn = openFolderBtn;
  }

  private setupEventListeners(): void {
    // Main menu toggle
    this.mainMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleDropdown(this.mainMenuDropdown);
      this.hideDropdown(this.settingsDropdown);
    });

    // Settings menu toggle
    this.settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleDropdown(this.settingsDropdown);
      this.hideDropdown(this.mainMenuDropdown);
    });

    // Open file button
    this.openFileBtn.addEventListener('click', () => {
      this.hideAllDropdowns();
      this.onOpenFile();
    });

    // Open folder button (if supported)
    if (this.openFolderBtn) {
      this.openFolderBtn.addEventListener('click', () => {
        this.hideAllDropdowns();
        this.onOpenFolder();
      });
    }

    // Theme toggle button
    this.themeToggleBtn.addEventListener('click', () => {
      this.hideAllDropdowns();
      this.onThemeToggle();
    });

    // Language toggle button
    if (this.languageToggleBtn) {
      this.languageToggleBtn.addEventListener('click', () => {
        this.hideAllDropdowns();
        this.onLanguageToggle();
      });
    }

    // About button
    if (this.aboutBtn) {
      this.aboutBtn.addEventListener('click', () => {
        this.hideAllDropdowns();
        this.onAbout();
      });
    }

    // Explorer toggle button
    this.explorerToggleBtn.addEventListener('click', () => {
      this.hideAllDropdowns();
      this.toggleExplorer();
    });

    // Close dropdowns when clicking outside
    document.addEventListener('click', () => {
      this.hideAllDropdowns();
    });

    // Prevent dropdown clicks from closing
    this.mainMenuDropdown.addEventListener('click', (e) => e.stopPropagation());
    this.settingsDropdown.addEventListener('click', (e) => e.stopPropagation());
  }

  private toggleDropdown(dropdown: HTMLElement): void {
    dropdown.classList.toggle('visible');
  }

  private hideDropdown(dropdown: HTMLElement): void {
    dropdown.classList.remove('visible');
  }

  private hideAllDropdowns(): void {
    this.hideDropdown(this.mainMenuDropdown);
    this.hideDropdown(this.settingsDropdown);
  }

  /**
   * エクスプローラーの表示/非表示を切り替え
   */
  private toggleExplorer(): void {
    this.explorerVisible = !this.explorerVisible;
    this.updateExplorerState();
    this.onExplorerToggle();
  }

  /**
   * エクスプローラーの状態を更新
   */
  private updateExplorerState(): void {
    const icon = this.explorerToggleBtn.querySelector('i');
    if (icon) {
      icon.className = this.explorerVisible ? 'fas fa-folder-open' : 'fas fa-folder';
    }
    this.explorerToggleBtn.classList.toggle('active', this.explorerVisible);
  }

  /**
   * エクスプローラーの表示状態を取得
   */
  isExplorerVisible(): boolean {
    return this.explorerVisible;
  }

  /**
   * エクスプローラーの表示状態を設定（外部から）
   */
  setExplorerVisible(visible: boolean): void {
    this.explorerVisible = visible;
    this.updateExplorerState();
  }

  /**
   * 現在の言語ラベルを更新
   */
  private updateLanguageLabel(): void {
    const label = document.getElementById('current-language-label');
    if (label) {
      const i18n = getI18n();
      label.textContent = i18n.getLocaleDisplayName(i18n.getLocale());
    }
  }
}
