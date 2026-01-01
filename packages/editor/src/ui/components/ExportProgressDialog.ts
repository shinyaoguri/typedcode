/**
 * ExportProgressDialog - エクスポート進行状況ダイアログ
 * Turnstile検証からZIPファイル生成までの進行状況を表示
 */

import { t } from '../../i18n/index.js';

/** エクスポートのフェーズ */
export type ExportPhase =
  | 'verification'    // Turnstile検証
  | 'preparing'       // データ準備中
  | 'screenshots'     // スクリーンショット取得
  | 'generating'      // ZIP生成
  | 'complete';       // 完了

/** 進行状況 */
export interface ExportProgress {
  phase: ExportPhase;
  current?: number;
  total?: number;
}

export class ExportProgressDialog {
  private overlay: HTMLElement | null = null;
  private progressBar: HTMLElement | null = null;
  private statusText: HTMLElement | null = null;
  private turnstileContainer: HTMLElement | null = null;

  /**
   * ダイアログを表示
   */
  show(): void {
    if (this.overlay) return;

    this.overlay = document.createElement('div');
    this.overlay.id = 'export-progress-dialog';
    this.overlay.className = 'modal-overlay';
    this.overlay.innerHTML = `
      <div class="modal-dialog modal-info export-progress-modal">
        <div class="modal-header">
          <i class="fas fa-file-export"></i>
          <h3>${t('export.progressTitle')}</h3>
        </div>
        <div class="modal-body">
          <!-- Phase Steps -->
          <div class="export-progress-steps">
            <div class="export-progress-step" id="export-step-verification" data-status="pending">
              <div class="step-indicator">
                <i class="fas fa-circle-notch fa-spin step-icon-loading"></i>
                <i class="fas fa-check step-icon-done"></i>
                <i class="fas fa-circle step-icon-pending"></i>
              </div>
              <div class="step-content">
                <span class="step-label">${t('export.phaseVerification')}</span>
              </div>
            </div>
            <div class="export-progress-step" id="export-step-preparing" data-status="pending">
              <div class="step-indicator">
                <i class="fas fa-circle-notch fa-spin step-icon-loading"></i>
                <i class="fas fa-check step-icon-done"></i>
                <i class="fas fa-circle step-icon-pending"></i>
              </div>
              <div class="step-content">
                <span class="step-label">${t('export.phasePreparing')}</span>
              </div>
            </div>
            <div class="export-progress-step" id="export-step-screenshots" data-status="pending">
              <div class="step-indicator">
                <i class="fas fa-circle-notch fa-spin step-icon-loading"></i>
                <i class="fas fa-check step-icon-done"></i>
                <i class="fas fa-circle step-icon-pending"></i>
              </div>
              <div class="step-content">
                <span class="step-label">${t('export.phaseScreenshots')}</span>
              </div>
            </div>
            <div class="export-progress-step" id="export-step-generating" data-status="pending">
              <div class="step-indicator">
                <i class="fas fa-circle-notch fa-spin step-icon-loading"></i>
                <i class="fas fa-check step-icon-done"></i>
                <i class="fas fa-circle step-icon-pending"></i>
              </div>
              <div class="step-content">
                <span class="step-label">${t('export.phaseGenerating')}</span>
              </div>
            </div>
          </div>

          <!-- Turnstile widget container -->
          <div class="export-turnstile-container hidden" id="export-turnstile-container">
            <div id="export-turnstile-widget"></div>
          </div>

          <!-- Progress bar -->
          <div class="processing-progress">
            <div class="processing-progress-bar" id="export-progress-bar"></div>
          </div>
          <p class="processing-status" id="export-status">${t('export.statusVerification')}</p>
        </div>
      </div>
    `;

    document.body.appendChild(this.overlay);

    // 要素への参照を取得
    this.progressBar = this.overlay.querySelector('#export-progress-bar');
    this.statusText = this.overlay.querySelector('#export-status');
    this.turnstileContainer = this.overlay.querySelector('#export-turnstile-container');
  }

  /**
   * Turnstileウィジェットのコンテナを取得
   */
  getTurnstileContainer(): HTMLElement | null {
    return this.overlay?.querySelector('#export-turnstile-widget') ?? null;
  }

  /**
   * Turnstileコンテナを表示
   */
  showTurnstileContainer(): void {
    this.turnstileContainer?.classList.remove('hidden');
  }

  /**
   * Turnstileコンテナを非表示
   */
  hideTurnstileContainer(): void {
    this.turnstileContainer?.classList.add('hidden');
  }

  /**
   * フェーズを更新
   */
  updatePhase(phase: ExportPhase): void {
    if (!this.overlay) return;

    const phases: ExportPhase[] = ['verification', 'preparing', 'screenshots', 'generating', 'complete'];
    const currentIndex = phases.indexOf(phase);

    phases.forEach((p, index) => {
      const stepEl = this.overlay?.querySelector(`#export-step-${p}`);
      if (!stepEl) return;

      if (index < currentIndex) {
        stepEl.setAttribute('data-status', 'done');
      } else if (index === currentIndex) {
        stepEl.setAttribute('data-status', 'active');
      } else {
        stepEl.setAttribute('data-status', 'pending');
      }
    });

    // Turnstileコンテナの表示/非表示
    if (phase === 'verification') {
      this.showTurnstileContainer();
    } else {
      this.hideTurnstileContainer();
    }

    // ステータステキストを更新
    if (this.statusText) {
      switch (phase) {
        case 'verification':
          this.statusText.textContent = t('export.statusVerification');
          break;
        case 'preparing':
          this.statusText.textContent = t('export.statusPreparing');
          break;
        case 'screenshots':
          this.statusText.textContent = t('export.statusScreenshots');
          break;
        case 'generating':
          this.statusText.textContent = t('export.statusGenerating');
          break;
        case 'complete':
          this.statusText.textContent = t('export.statusComplete');
          break;
      }
    }

    // プログレスバーの更新（フェーズベース）
    if (this.progressBar) {
      const progressMap: Record<ExportPhase, number> = {
        verification: 10,
        preparing: 40,
        screenshots: 70,
        generating: 90,
        complete: 100,
      };
      this.progressBar.style.width = `${progressMap[phase]}%`;
    }
  }

  /**
   * 進行状況を更新（詳細）
   */
  updateProgress(progress: ExportProgress): void {
    this.updatePhase(progress.phase);

    if (this.statusText && progress.current !== undefined && progress.total !== undefined) {
      const phaseText = this.getPhaseText(progress.phase);
      this.statusText.textContent = `${phaseText} (${progress.current}/${progress.total})`;
    }
  }

  /**
   * フェーズのテキストを取得
   */
  private getPhaseText(phase: ExportPhase): string {
    switch (phase) {
      case 'verification':
        return t('export.statusVerification');
      case 'preparing':
        return t('export.statusPreparing');
      case 'screenshots':
        return t('export.statusScreenshots');
      case 'generating':
        return t('export.statusGenerating');
      case 'complete':
        return t('export.statusComplete');
      default:
        return '';
    }
  }

  /**
   * ダイアログを非表示
   */
  hide(): void {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
      this.progressBar = null;
      this.statusText = null;
      this.turnstileContainer = null;
    }
  }

  /**
   * ダイアログが表示中かどうか
   */
  isVisible(): boolean {
    return this.overlay !== null;
  }
}
