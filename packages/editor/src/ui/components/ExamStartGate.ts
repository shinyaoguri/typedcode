/**
 * ExamStartGate - 試験モード (ADR-0006) のブロック型開始ゲート
 *
 * エディタを覆う全画面オーバーレイで、受験者に:
 *   ① 封印問題パッケージ (.tcexam) をファイル取込 (ピッカー / ドラッグ&ドロップ)
 *   ② 監督コードを入力
 *   ③「開始」
 * を求める。開始時に署名検証 → 復号 (Argon2id + AES-256-GCM) を行い、成功したら
 * `{ manifest, plaintext, examContext }` を resolve する。**genesis = この解錠の瞬間**。
 *
 * 解錠まではエディタを操作できず、URL 改竄でもバイパスできない (sticky exam mode)。
 * 誤コードは GCM 認証で弾かれ、ゲート内でリトライできる (試行回数無制限)。
 */

import {
  verifyExamPackageSignature,
  decryptExamPackage,
  canonicalizeStartToken,
  computeExamPackageHash,
  computeProblemContentHash,
  parseExamPackageManifest,
  escapeHtml,
  type ExamPackageManifest,
  type ExamSessionContext,
} from '@typedcode/shared';
import { t } from '../../i18n/index.js';

export interface ExamUnlockResult {
  manifest: ExamPackageManifest;
  plaintext: string;
  examContext: ExamSessionContext;
}

export class ExamStartGate {
  private overlay: HTMLElement | null = null;
  private manifest: ExamPackageManifest | null = null;

  /** ゲートを表示し、解錠成功で result を resolve する (キャンセル経路は無い = sticky)。 */
  prompt(): Promise<ExamUnlockResult> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'exam-gate-overlay';
      overlay.id = 'exam-start-gate';
      overlay.innerHTML = this.render();
      document.body.appendChild(overlay);
      this.overlay = overlay;

      const fileInput = overlay.querySelector<HTMLInputElement>('#exam-gate-file')!;
      const dropzone = overlay.querySelector<HTMLElement>('#exam-gate-dropzone')!;
      const filenameEl = overlay.querySelector<HTMLElement>('#exam-gate-filename')!;
      const codeInput = overlay.querySelector<HTMLInputElement>('#exam-gate-code')!;
      const startBtn = overlay.querySelector<HTMLButtonElement>('#exam-gate-start')!;
      const errorEl = overlay.querySelector<HTMLElement>('#exam-gate-error')!;

      const showError = (msg: string): void => {
        errorEl.textContent = msg;
        errorEl.hidden = false;
      };
      const clearError = (): void => {
        errorEl.hidden = true;
      };
      const refreshStartEnabled = (): void => {
        startBtn.disabled = !this.manifest || codeInput.value.trim().length === 0;
      };

      const handleFile = (file: File): void => {
        clearError();
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const parsed = parseExamPackageManifest(JSON.parse(String(reader.result)));
            if (!parsed) {
              throw new Error('not a manifest');
            }
            this.manifest = parsed;
            filenameEl.textContent = file.name;
            dropzone.classList.add('has-file');
          } catch {
            this.manifest = null;
            dropzone.classList.remove('has-file');
            filenameEl.textContent = t('exam.gate.dropHint');
            showError(t('exam.gate.errorInvalidFile'));
          }
          refreshStartEnabled();
        };
        reader.onerror = () => showError(t('exam.gate.errorInvalidFile'));
        reader.readAsText(file);
      };

      // ファイル取込 (ピッカー)
      dropzone.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (file) handleFile(file);
      });

      // ファイル取込 (ドラッグ&ドロップ)
      ['dragenter', 'dragover'].forEach((evt) =>
        dropzone.addEventListener(evt, (e) => {
          e.preventDefault();
          dropzone.classList.add('dragover');
        })
      );
      ['dragleave', 'drop'].forEach((evt) =>
        dropzone.addEventListener(evt, (e) => {
          e.preventDefault();
          dropzone.classList.remove('dragover');
        })
      );
      dropzone.addEventListener('drop', (e) => {
        const file = (e as DragEvent).dataTransfer?.files?.[0];
        if (file) handleFile(file);
      });

      codeInput.addEventListener('input', () => {
        clearError();
        refreshStartEnabled();
      });
      codeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !startBtn.disabled) startBtn.click();
      });

      startBtn.addEventListener('click', () => {
        void this.attemptUnlock(codeInput.value, startBtn, showError, clearError, (result) => {
          this.close();
          resolve(result);
        });
      });

      setTimeout(() => codeInput.focus(), 50);
    });
  }

  /** 署名検証 → 復号 → examContext 構築。失敗時はゲートに留まりエラー表示する。 */
  private async attemptUnlock(
    rawCode: string,
    startBtn: HTMLButtonElement,
    showError: (msg: string) => void,
    clearError: () => void,
    onSuccess: (result: ExamUnlockResult) => void
  ): Promise<void> {
    if (!this.manifest) {
      showError(t('exam.gate.errorNoFile'));
      return;
    }
    const manifest = this.manifest;
    const token = canonicalizeStartToken(rawCode);
    if (token.length === 0) {
      showError(t('exam.gate.errorNoCode'));
      return;
    }

    clearError();
    const originalLabel = startBtn.innerHTML;
    startBtn.disabled = true;
    startBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${escapeHtml(t('exam.gate.unlocking'))}`;

    try {
      // 1. 出題者鍵レジストリで署名検証 (本物の問題か)
      const sig = await verifyExamPackageSignature(manifest);
      if (!sig.valid) {
        showError(t('exam.gate.errorUntrusted'));
        return;
      }
      // 2. 監督コードで復号 (誤コードは GCM 認証で失敗)
      const dec = await decryptExamPackage(manifest, token);
      if (!dec.ok) {
        showError(t('exam.gate.errorWrongCode'));
        return;
      }
      // 3. 束縛コンテキストを構築
      const packageHash = await computeExamPackageHash(manifest);
      const problemContentHash = await computeProblemContentHash(dec.plaintext);
      const examContext: ExamSessionContext = {
        examId: manifest.examId,
        problemId: manifest.problemId,
        variant: manifest.variant,
        packageHash,
        problemContentHash,
        startToken: token,
      };
      onSuccess({ manifest, plaintext: dec.plaintext, examContext });
    } catch {
      showError(t('exam.gate.errorUnlockFailed'));
    } finally {
      startBtn.innerHTML = originalLabel;
      startBtn.disabled = false;
    }
  }

  private close(): void {
    this.overlay?.classList.add('hidden');
    const overlay = this.overlay;
    setTimeout(() => overlay?.remove(), 200);
    this.overlay = null;
  }

  private render(): string {
    return `
      <div class="exam-gate-content">
        <i class="fas fa-lock fa-3x exam-gate-icon"></i>
        <h2>${escapeHtml(t('exam.gate.title'))}</h2>
        <p class="exam-gate-desc">${escapeHtml(t('exam.gate.description'))}</p>

        <div class="exam-gate-field">
          <label>${escapeHtml(t('exam.gate.packageLabel'))}</label>
          <div class="exam-gate-dropzone" id="exam-gate-dropzone">
            <i class="fas fa-file-arrow-up"></i>
            <span id="exam-gate-filename">${escapeHtml(t('exam.gate.dropHint'))}</span>
            <input type="file" id="exam-gate-file" accept=".tcexam,application/json" hidden>
          </div>
        </div>

        <div class="exam-gate-field">
          <label for="exam-gate-code">${escapeHtml(t('exam.gate.codeLabel'))}</label>
          <input type="text" id="exam-gate-code" class="exam-gate-code-input"
                 autocomplete="off" autocapitalize="characters" spellcheck="false"
                 placeholder="ABCD-EFGH">
        </div>

        <p class="exam-gate-error" id="exam-gate-error" hidden></p>

        <button class="btn btn-primary exam-gate-start" id="exam-gate-start" disabled>
          <i class="fas fa-play"></i> ${escapeHtml(t('exam.gate.startButton'))}
        </button>

        <p class="exam-gate-hint">${escapeHtml(t('exam.gate.resetHint'))}</p>
      </div>
    `;
  }
}
