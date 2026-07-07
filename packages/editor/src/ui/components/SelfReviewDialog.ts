/**
 * SelfReviewDialog - 提出前セルフレビュー (ADR-0022)
 *
 * export 直前に自分の制作過程 (ProcessSummary) を確認し、任意の振り返りノートを
 * 書けるモーダル。位置づけは「監視ではなく鏡」— 学生が自分の過程を先に見る。
 *
 * - ノートは任意。空のまま進めば reflectionNote イベントは記録されない
 * - キャンセルで export 自体を中止できる
 * - 表示は中立 (疑い・判定の意味づけをしない)
 */

import type { ProcessSummary } from '@typedcode/shared';
import { t } from '../../i18n/index.js';

export interface SelfReviewResult {
  /** export を続行するか (false = キャンセル)。 */
  proceed: boolean;
  /** 振り返りノート。空文字なら記録しない。 */
  note: string;
}

export class SelfReviewDialog {
  private overlay: HTMLElement | null = null;

  /**
   * ダイアログを表示し、ユーザの選択を返す。
   */
  show(summary: ProcessSummary): Promise<SelfReviewResult> {
    return new Promise((resolve) => {
      this.close();

      const overlay = document.createElement('div');
      overlay.className = 'self-review-overlay';
      overlay.innerHTML = `
        <div class="self-review-dialog" role="dialog" aria-modal="true">
          <div class="self-review-header">
            <h2>${t('selfReview.title')}</h2>
            <button type="button" class="self-review-close" aria-label="${t('selfReview.cancel')}">×</button>
          </div>
          <p class="self-review-lead">${t('selfReview.lead')}</p>
          <div class="self-review-stats">
            ${this.stat(t('selfReview.duration'), formatDuration(summary.durationMs))}
            ${this.stat(t('selfReview.edits'), `+${summary.insertedChars.toLocaleString()} / -${summary.deletedChars.toLocaleString()}`)}
            ${this.stat(t('selfReview.runs'), this.runsLabel(summary))}
            ${this.stat(t('selfReview.pauses'), String(summary.pauseCount))}
          </div>
          <label class="self-review-note-label" for="self-review-note">${t('selfReview.noteLabel')}</label>
          <textarea id="self-review-note" class="self-review-note" rows="4"
            placeholder="${t('selfReview.notePlaceholder')}"></textarea>
          <p class="self-review-note-hint">${t('selfReview.noteHint')}</p>
          <div class="self-review-actions">
            <button type="button" class="self-review-btn-cancel">${t('selfReview.cancel')}</button>
            <button type="button" class="self-review-btn-proceed">${t('selfReview.proceed')}</button>
          </div>
        </div>
      `;

      const finish = (result: SelfReviewResult): void => {
        this.close();
        resolve(result);
      };

      const textarea = overlay.querySelector<HTMLTextAreaElement>('#self-review-note')!;
      overlay
        .querySelector('.self-review-btn-proceed')!
        .addEventListener('click', () => finish({ proceed: true, note: textarea.value.trim() }));
      overlay
        .querySelector('.self-review-btn-cancel')!
        .addEventListener('click', () => finish({ proceed: false, note: '' }));
      overlay
        .querySelector('.self-review-close')!
        .addEventListener('click', () => finish({ proceed: false, note: '' }));

      this.overlay = overlay;
      document.body.appendChild(overlay);
      textarea.focus();
    });
  }

  private runsLabel(summary: ProcessSummary): string {
    if (!summary.hasRunResults) return String(summary.executionCount);
    return `${summary.executionCount} (✓${summary.runSuccessCount} ✗${summary.runFailureCount})`;
  }

  private stat(label: string, value: string): string {
    return `
      <div class="self-review-stat">
        <span class="self-review-stat-label">${label}</span>
        <span class="self-review-stat-value">${value}</span>
      </div>
    `;
  }

  private close(): void {
    this.overlay?.remove();
    this.overlay = null;
  }
}

/** ms を「1h 23m」「4m 05s」「12s」形式へ。 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}
