/**
 * ClassProblemLoader - 授業モード (ADR-0014) の**非ブロッキング**問題ローダ
 *
 * エディタを覆うオーバーレイで、受講者に平文問題ファイル (.tcclass) の取込
 * (ピッカー / ドラッグ&ドロップ) を促す。exam の ExamStartGate と異なり:
 *   - **監督コードは無い** (封印しない tier ①、問題は公開前提)
 *   - **署名検証もしない** (自己申告。`parseClassPackage` で構造検証のみ)
 *   - **スキップ可能** (素のエディタで開始できる) → resolve(null)
 *
 * 視覚は exam-gate-* の CSS クラスを流用する (見た目を統一)。
 */

import { parseClassPackage, escapeHtml, type ClassPackage } from '@typedcode/shared';
import { t } from '../../i18n/index.js';
import { attachDialogA11y, type DialogA11yHandle } from './dialogA11y.js';
import { makeDropzoneKeyboardOperable } from './dropzoneKeyboard.js';

export class ClassProblemLoader {
  private overlay: HTMLElement | null = null;
  private a11y: DialogA11yHandle | null = null;
  private pkg: ClassPackage | null = null;

  /** ローダを表示し、読み込んだ ClassPackage、またはスキップ時は null を resolve する。 */
  prompt(): Promise<ClassPackage | null> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'exam-gate-overlay';
      overlay.id = 'class-problem-loader';
      // 状態契約 (packages/editor/AGENTS.md「状態契約」): 閉じると `.hidden` が付いてから DOM を外れる。
      overlay.dataset.dialog = 'class-problem-loader';
      overlay.innerHTML = this.render();
      document.body.appendChild(overlay);
      this.overlay = overlay;

      const fileInput = overlay.querySelector<HTMLInputElement>('#class-loader-file')!;
      const dropzone = overlay.querySelector<HTMLElement>('#class-loader-dropzone')!;
      const filenameEl = overlay.querySelector<HTMLElement>('#class-loader-filename')!;
      const loadBtn = overlay.querySelector<HTMLButtonElement>('#class-loader-load')!;
      const skipBtn = overlay.querySelector<HTMLButtonElement>('#class-loader-skip')!;
      const errorEl = overlay.querySelector<HTMLElement>('#class-loader-error')!;

      const showError = (msg: string): void => {
        errorEl.textContent = msg;
        errorEl.hidden = false;
      };
      const clearError = (): void => {
        errorEl.hidden = true;
      };
      const refreshLoadEnabled = (): void => {
        loadBtn.disabled = !this.pkg;
      };

      const handleFile = (file: File): void => {
        clearError();
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const parsed = parseClassPackage(JSON.parse(String(reader.result)));
            if (!parsed) throw new Error('not a class package');
            this.pkg = parsed;
            filenameEl.textContent = file.name;
            dropzone.classList.add('has-file');
          } catch {
            this.pkg = null;
            dropzone.classList.remove('has-file');
            filenameEl.textContent = t('class.loader.dropHint');
            showError(t('class.loader.errorInvalidFile'));
          }
          refreshLoadEnabled();
        };
        reader.onerror = () => showError(t('class.loader.errorInvalidFile'));
        reader.readAsText(file);
      };

      // ファイル取込 (ピッカー。キーボードでは Enter / Space。#743)
      dropzone.addEventListener('click', () => fileInput.click());
      makeDropzoneKeyboardOperable(dropzone, () => fileInput.click());
      fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (file) handleFile(file);
      });

      // ファイル取込 (ドラッグ&ドロップ)
      for (const evt of ['dragenter', 'dragover']) {
        dropzone.addEventListener(evt, (e) => {
          e.preventDefault();
          dropzone.classList.add('dragover');
        });
      }
      for (const evt of ['dragleave', 'drop']) {
        dropzone.addEventListener(evt, (e) => {
          e.preventDefault();
          dropzone.classList.remove('dragover');
        });
      }
      dropzone.addEventListener('drop', (e) => {
        const file = (e as DragEvent).dataTransfer?.files?.[0];
        if (file) handleFile(file);
      });

      loadBtn.addEventListener('click', () => {
        if (!this.pkg) return;
        const pkg = this.pkg;
        this.close();
        resolve(pkg);
      });
      skipBtn.addEventListener('click', () => {
        this.close();
        resolve(null);
      });

      // a11y (#743): 名前付きの modal dialog にし、Tab を閉じ込める。閉じる経路は「読み込む」「スキップ」だけで、
      // Escape では閉じない (閉鎖規則は #305 以前のまま)。閉じるとフォーカスは開いた起点 (「問題を読み込む」) へ戻る
      this.a11y = attachDialogA11y(overlay.querySelector<HTMLElement>('.exam-gate-content')!, {
        labelledBy: overlay.querySelector<HTMLElement>('h2')!,
        closeOnEscape: false,
        onRequestClose: () => undefined,
      });
    });
  }

  private close(): void {
    this.a11y?.close();
    this.a11y = null;
    this.overlay?.classList.add('hidden');
    const overlay = this.overlay;
    setTimeout(() => overlay?.remove(), 200);
    this.overlay = null;
  }

  private render(): string {
    return `
      <div class="exam-gate-content">
        <i class="fas fa-book-open fa-3x exam-gate-icon"></i>
        <h2 id="class-loader-title">${escapeHtml(t('class.loader.title'))}</h2>
        <p class="exam-gate-desc">${escapeHtml(t('class.loader.description'))}</p>

        <div class="exam-gate-field">
          <label id="class-loader-package-label">${escapeHtml(t('class.loader.packageLabel'))}</label>
          <div class="exam-gate-dropzone" id="class-loader-dropzone" role="button" tabindex="0"
               aria-labelledby="class-loader-package-label class-loader-filename">
            <i class="fas fa-file-arrow-up"></i>
            <span id="class-loader-filename">${escapeHtml(t('class.loader.dropHint'))}</span>
            <input type="file" id="class-loader-file" accept=".tcclass,application/json" hidden>
          </div>
        </div>

        <p class="exam-gate-error" id="class-loader-error" hidden></p>

        <div class="class-loader-actions">
          <button class="btn btn-primary exam-gate-start" id="class-loader-load" disabled>
            <i class="fas fa-play"></i> ${escapeHtml(t('class.loader.loadButton'))}
          </button>
          <button class="btn btn-secondary" id="class-loader-skip">
            ${escapeHtml(t('class.loader.skipButton'))}
          </button>
        </div>
      </div>
    `;
  }
}
