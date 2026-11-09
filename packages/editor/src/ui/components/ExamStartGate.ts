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
  parseExamPackageManifestResult,
  escapeHtml,
  type ExamPackageManifest,
} from '@typedcode/shared';
import { t } from '../../i18n/index.js';

/**
 * ゲート内の人間確認 (Turnstile) の状態 (#236)。`#exam-gate-attestation[data-attestation-state]` に出す。
 * - `off`: 確認しない (Turnstile 未設定など。欄を出さない)
 * - `pending`: 確認中 (widget を表示中、または session/start の応答待ち)
 * - `verified`: 確認できた (#0 が verified になる)
 * - `failed`: 確認できなかった (解錠はできる。#0 は合成の印になる)
 */
export type ExamGateAttestationState = 'off' | 'pending' | 'verified' | 'failed';

/** ゲート内で Turnstile の widget を描く容器 (#236。`performTurnstileVerification` にそのまま渡す) */
export interface ExamGateAttestationSlot {
  widgetContainer: HTMLElement;
  parentContainer: HTMLElement;
}

/**
 * 解錠結果 (ADR-0006/0012)。ゲートは署名検証 + 復号までを担い、セッション構築
 * (問題=タブの分解 / examContext の組み立て) は呼び出し側 (runExamUnlock) に委ねる。
 * 平文は単一 markdown (v1) か N問バンドル (v2) で、呼び出し側が decodeExamPlaintext で分岐する。
 */
export interface ExamUnlockResult {
  manifest: ExamPackageManifest;
  plaintext: string;
  /** SHA-256(signing core)。各タブの束縛で共有する。 */
  packageHash: string;
  /** 監督コード (正準形)。 */
  startToken: string;
}

export class ExamStartGate {
  private overlay: HTMLElement | null = null;
  private manifest: ExamPackageManifest | null = null;

  /**
   * ゲート内の人間確認の容器 (#236)。`prompt()` を呼んだ後 (オーバーレイを描いた後) だけ返す。
   * 呼び出し側 (runExamUnlock) はここに Turnstile を描き、解錠と並行して先行取得する。
   */
  attestationSlot(): ExamGateAttestationSlot | null {
    const widgetContainer = this.overlay?.querySelector<HTMLElement>('#exam-gate-turnstile-widget');
    const parentContainer = this.overlay?.querySelector<HTMLElement>('#exam-gate-turnstile');
    return widgetContainer && parentContainer ? { widgetContainer, parentContainer } : null;
  }

  /**
   * 人間確認の状態を表示する (#236)。解錠はこの状態を待たない (確認中・失敗でも「開始」できる)。
   * ゲートを閉じた後に呼ばれても何もしない。
   */
  setAttestationState(state: ExamGateAttestationState): void {
    const section = this.overlay?.querySelector<HTMLElement>('#exam-gate-attestation');
    const status = this.overlay?.querySelector<HTMLElement>('#exam-gate-attestation-status');
    if (!section || !status) return;
    section.dataset.attestationState = state;
    section.hidden = state === 'off';
    const messages: Record<Exclude<ExamGateAttestationState, 'off'>, { icon: string; text: string }> = {
      pending: { icon: 'fa-spinner fa-spin', text: t('exam.gate.attestationPending') },
      verified: { icon: 'fa-circle-check', text: t('exam.gate.attestationVerified') },
      failed: { icon: 'fa-circle-exclamation', text: t('exam.gate.attestationFailed') },
    };
    if (state === 'off') {
      status.textContent = '';
      return;
    }
    const { icon, text } = messages[state];
    status.innerHTML = `<i class="fas ${icon}" aria-hidden="true"></i> ${escapeHtml(text)}`;
  }

  /** ゲートを表示し、解錠成功で result を resolve する (キャンセル経路は無い = sticky)。 */
  prompt(): Promise<ExamUnlockResult> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'exam-gate-overlay';
      overlay.dataset.dialog = 'exam-gate';
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

      // reason は E2E が翻訳テキストではなくこれを読むための状態契約 (editor/AGENTS.md)。
      // 取込の拒否理由 (`invalid-file` / `newer-format` / `unsupported-format`) だけに付け、他の誤りでは付けない。
      const showError = (msg: string, reason?: string): void => {
        errorEl.textContent = msg;
        if (reason) errorEl.dataset.reason = reason;
        else delete errorEl.dataset.reason;
        errorEl.hidden = false;
      };
      const clearError = (): void => {
        errorEl.hidden = true;
        delete errorEl.dataset.reason;
      };
      const refreshStartEnabled = (): void => {
        startBtn.disabled = !this.manifest || codeInput.value.trim().length === 0;
      };

      const handleFile = (file: File): void => {
        clearError();
        const reader = new FileReader();
        reader.onload = () => {
          // #223: 「壊れている」と「このエディタより新しい / もう対応しない形式」を出し分ける。
          // 新しい形式を「不正」と読ませると、受験者はファイルを選び直し続けてしまう。
          let rejection: { message: string; reason: string } | null = null;
          try {
            const parsed = parseExamPackageManifestResult(JSON.parse(String(reader.result)));
            if (parsed.ok) {
              this.manifest = parsed.manifest;
              filenameEl.textContent = file.name;
              dropzone.classList.add('has-file');
            } else if (parsed.code === 'unsupportedFormatVersion') {
              rejection = parsed.newer
                ? { message: t('exam.gate.errorNewerFormat'), reason: 'newer-format' }
                : { message: t('exam.gate.errorUnsupportedFormat'), reason: 'unsupported-format' };
            } else {
              rejection = { message: t('exam.gate.errorInvalidFile'), reason: 'invalid-file' };
            }
          } catch {
            rejection = { message: t('exam.gate.errorInvalidFile'), reason: 'invalid-file' };
          }
          if (rejection) {
            this.manifest = null;
            dropzone.classList.remove('has-file');
            filenameEl.textContent = t('exam.gate.dropHint');
            showError(rejection.message, rejection.reason);
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
      // 3. packageHash を確定し、セッション構築は呼び出し側へ渡す
      //    (問題=タブの分解と examContext 組み立ては runExamUnlock が decodeExamPlaintext で行う)。
      const packageHash = await computeExamPackageHash(manifest);
      onSuccess({ manifest, plaintext: dec.plaintext, packageHash, startToken: token });
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

        <div class="exam-gate-attestation" id="exam-gate-attestation" data-attestation-state="off" hidden>
          <p class="exam-gate-attestation-status" id="exam-gate-attestation-status" role="status" aria-live="polite"></p>
          <div class="exam-gate-turnstile hidden" id="exam-gate-turnstile">
            <div id="exam-gate-turnstile-widget"></div>
          </div>
        </div>

        <p class="exam-gate-error" id="exam-gate-error" hidden></p>

        <button class="btn btn-primary exam-gate-start" id="exam-gate-start" disabled>
          <i class="fas fa-play"></i> ${escapeHtml(t('exam.gate.startButton'))}
        </button>
      </div>
    `;
  }
}
