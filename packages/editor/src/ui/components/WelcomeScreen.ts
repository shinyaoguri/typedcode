/**
 * WelcomeScreen - 起動時のウェルカム画面コンポーネント
 * タブがない場合にエディタ領域に表示される
 */

import { t } from '../../i18n/index.js';

export interface WelcomeScreenOptions {
  container: HTMLElement;
  onNewFile: () => Promise<void>;
  onImportTemplate: () => Promise<void>;
}

export class WelcomeScreen {
  private element: HTMLElement | null = null;
  private isDisposed = false;

  constructor(private options: WelcomeScreenOptions) {}

  /**
   * ウェルカム画面を表示
   */
  show(): void {
    if (this.isDisposed || this.element) return;

    this.element = document.createElement('div');
    this.element.className = 'welcome-screen';
    this.element.innerHTML = `
      <div class="welcome-content">
        <div class="welcome-logo">
          <img src="/icon-192.png" alt="TypedCode" />
          <h1>${t('welcome.title')}</h1>
          <p class="welcome-tagline">${t('welcome.tagline')}</p>
        </div>

        <div class="welcome-actions">
          <h2>${t('welcome.startSection')}</h2>
          <button class="welcome-action" id="welcome-new-file">
            <i class="fas fa-file-circle-plus"></i>
            <span>${t('welcome.newFile')}</span>
          </button>
          <button class="welcome-action" id="welcome-import-template">
            <i class="fas fa-file-import"></i>
            <span>${t('welcome.importTemplate')}</span>
          </button>
        </div>
      </div>
    `;

    // イベントリスナーを設定
    const newFileBtn = this.element.querySelector('#welcome-new-file');
    const importTemplateBtn = this.element.querySelector('#welcome-import-template');

    newFileBtn?.addEventListener('click', () => {
      this.options.onNewFile();
    });

    importTemplateBtn?.addEventListener('click', () => {
      this.options.onImportTemplate();
    });

    this.options.container.appendChild(this.element);
  }

  /**
   * ウェルカム画面を非表示
   */
  hide(): void {
    if (this.element) {
      this.element.remove();
      this.element = null;
    }
  }

  /**
   * コンポーネントを破棄
   */
  dispose(): void {
    this.hide();
    this.isDisposed = true;
  }
}
