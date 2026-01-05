/**
 * TemplateImportDialog - テンプレートインポートダイアログ
 * ファイル選択と確認ダイアログを提供
 */

import type { ParsedTemplate } from '@typedcode/shared';
import { t } from '../i18n/index.js';

/** ダイアログ結果 */
export interface TemplateImportDialogResult {
  confirmed: boolean;
  file: File | null;
  content: string | null;
  template: ParsedTemplate | null;
}

export class TemplateImportDialog {
  /**
   * ファイル選択ダイアログを表示
   */
  async selectFile(): Promise<File | null> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.yaml,.yml';

      input.addEventListener('change', () => {
        const file = input.files?.[0] ?? null;
        resolve(file);
      });

      // キャンセル時
      input.addEventListener('cancel', () => {
        resolve(null);
      });

      input.click();
    });
  }

  /**
   * 確認ダイアログを表示
   * @param template - パース済みテンプレート
   * @param hasExistingTabs - 既存タブがあるか
   * @returns 確認結果
   */
  async showConfirmation(template: ParsedTemplate, hasExistingTabs: boolean): Promise<boolean> {
    return new Promise((resolve) => {
      // モーダル要素を作成
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
      `;

      const modal = document.createElement('div');
      modal.className = 'template-import-modal';
      modal.style.cssText = `
        background: var(--vscode-editor-background, #1e1e1e);
        border: 1px solid var(--vscode-panel-border, #3c3c3c);
        border-radius: 6px;
        padding: 20px;
        max-width: 500px;
        width: 90%;
        color: var(--vscode-foreground, #cccccc);
      `;

      const templateName = template.metadata.name ?? t('template.unnamedTemplate');
      const fileCount = template.files.length;

      // ファイルリストを生成
      const fileList = template.files
        .map(f => `<li style="margin: 4px 0; font-family: monospace;">${this.escapeHtml(f.filename)} (${f.language})</li>`)
        .join('');

      modal.innerHTML = `
        <h3 style="margin: 0 0 16px 0; font-size: 16px;">${t('template.confirmTitle')}</h3>
        <div style="margin-bottom: 16px;">
          <p style="margin: 0 0 8px 0;"><strong>${t('template.templateName')}:</strong> ${this.escapeHtml(templateName)}</p>
          <p style="margin: 0 0 8px 0;"><strong>${t('template.fileCount')}:</strong> ${fileCount}</p>
          ${template.metadata.author ? `<p style="margin: 0 0 8px 0;"><strong>${t('template.author')}:</strong> ${this.escapeHtml(template.metadata.author)}</p>` : ''}
          ${template.metadata.description ? `<p style="margin: 0 0 8px 0;"><strong>${t('template.description')}:</strong> ${this.escapeHtml(template.metadata.description)}</p>` : ''}
        </div>
        <div style="margin-bottom: 16px;">
          <p style="margin: 0 0 8px 0; font-weight: bold;">${t('template.filesToCreate')}:</p>
          <ul style="margin: 0; padding-left: 20px; max-height: 150px; overflow-y: auto;">
            ${fileList}
          </ul>
        </div>
        ${hasExistingTabs ? `
          <div style="background: var(--vscode-inputValidation-warningBackground, #352a05); border: 1px solid var(--vscode-inputValidation-warningBorder, #9d8c00); padding: 10px; border-radius: 4px; margin-bottom: 16px;">
            <p style="margin: 0; color: var(--vscode-inputValidation-warningForeground, #cca700);">
              <i class="fas fa-exclamation-triangle" style="margin-right: 8px;"></i>
              ${t('template.warningExistingTabs')}
            </p>
          </div>
        ` : ''}
        <div style="display: flex; justify-content: flex-end; gap: 10px;">
          <button id="template-cancel-btn" style="
            padding: 8px 16px;
            background: transparent;
            border: 1px solid var(--vscode-button-border, #3c3c3c);
            color: var(--vscode-foreground, #cccccc);
            border-radius: 4px;
            cursor: pointer;
          ">${t('common.cancel')}</button>
          <button id="template-confirm-btn" style="
            padding: 8px 16px;
            background: var(--vscode-button-background, #0e639c);
            border: none;
            color: var(--vscode-button-foreground, #ffffff);
            border-radius: 4px;
            cursor: pointer;
          ">${t('template.import')}</button>
        </div>
      `;

      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      // イベントハンドラ
      const confirmBtn = modal.querySelector('#template-confirm-btn');
      const cancelBtn = modal.querySelector('#template-cancel-btn');

      const cleanup = () => {
        document.body.removeChild(overlay);
      };

      confirmBtn?.addEventListener('click', () => {
        cleanup();
        resolve(true);
      });

      cancelBtn?.addEventListener('click', () => {
        cleanup();
        resolve(false);
      });

      // オーバーレイクリックでキャンセル
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          cleanup();
          resolve(false);
        }
      });

      // Escキーでキャンセル
      const escHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          cleanup();
          document.removeEventListener('keydown', escHandler);
          resolve(false);
        }
      };
      document.addEventListener('keydown', escHandler);
    });
  }

  /**
   * 進捗表示を更新するためのモーダルを表示
   */
  showProgress(): { update: (current: number, total: number, filename: string) => void; close: () => void } {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
    `;

    const modal = document.createElement('div');
    modal.className = 'template-progress-modal';
    modal.style.cssText = `
      background: var(--vscode-editor-background, #1e1e1e);
      border: 1px solid var(--vscode-panel-border, #3c3c3c);
      border-radius: 6px;
      padding: 20px;
      max-width: 400px;
      width: 90%;
      color: var(--vscode-foreground, #cccccc);
      text-align: center;
    `;

    modal.innerHTML = `
      <h3 style="margin: 0 0 16px 0; font-size: 16px;">${t('template.importing')}</h3>
      <div id="template-progress-info" style="margin-bottom: 12px;">
        <span id="template-progress-current">0</span> / <span id="template-progress-total">0</span>
      </div>
      <div id="template-progress-filename" style="font-family: monospace; margin-bottom: 12px;"></div>
      <div style="background: var(--vscode-progressBar-background, #3c3c3c); height: 4px; border-radius: 2px; overflow: hidden;">
        <div id="template-progress-bar" style="background: var(--vscode-progressBar-foreground, #0e639c); height: 100%; width: 0%; transition: width 0.2s;"></div>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const currentEl = modal.querySelector('#template-progress-current') as HTMLElement;
    const totalEl = modal.querySelector('#template-progress-total') as HTMLElement;
    const filenameEl = modal.querySelector('#template-progress-filename') as HTMLElement;
    const progressBar = modal.querySelector('#template-progress-bar') as HTMLElement;

    return {
      update: (current: number, total: number, filename: string) => {
        currentEl.textContent = String(current);
        totalEl.textContent = String(total);
        filenameEl.textContent = filename;
        progressBar.style.width = `${(current / total) * 100}%`;
      },
      close: () => {
        if (document.body.contains(overlay)) {
          document.body.removeChild(overlay);
        }
      },
    };
  }

  /**
   * HTMLエスケープ
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// シングルトンエクスポート
export const templateImportDialog = new TemplateImportDialog();
