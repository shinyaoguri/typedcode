/**
 * ProcessSummaryCard - プロセス要約 (Phase 8 W3) の表示カード
 *
 * 採点者が提出物 1 件の制作過程を 30 秒で掴むための要約。中立な記述であって
 * 疑いの表示ではない (疑いは AnalysisReportCard の責務)。各見どころは
 * `verify:seek-to-event` でシークバーの当該イベントへジャンプできる。
 */

import { escapeHtml, type ProcessSummary, type ProcessKeyMoment, type ProcessMomentKind } from '@typedcode/shared';
import { t } from '../i18n/index.js';

export class ProcessSummaryCard {
  private cardElement: HTMLElement | null = null;

  show(): void {
    this.cardElement = document.getElementById('card-process-summary');
    if (this.cardElement) this.cardElement.style.display = '';
  }

  hide(): void {
    this.cardElement = document.getElementById('card-process-summary');
    if (this.cardElement) this.cardElement.style.display = 'none';
  }

  render(summary: ProcessSummary): void {
    this.show();
    this.cardElement = document.getElementById('card-process-summary');
    if (!this.cardElement) return;

    const badge = this.cardElement.querySelector('#process-summary-badge');
    if (badge) {
      badge.className = 'result-card-badge success';
      badge.textContent = `${t('process.moments')} ${summary.moments.length}`;
    }

    const content = this.cardElement.querySelector('#process-summary-content');
    if (content) {
      content.innerHTML = this.renderContent(summary);
      this.setupEventListeners(content);
    }
  }

  private renderContent(summary: ProcessSummary): string {
    const ratio = summary.deletionRatio !== null ? `${(summary.deletionRatio * 100).toFixed(0)}%` : '—';

    const stats = `
      <div class="process-stats">
        ${this.stat(t('process.duration'), formatDuration(summary.durationMs))}
        ${this.stat(t('process.inserted'), `${summary.insertedChars.toLocaleString()} ${t('process.chars')}`)}
        ${this.stat(t('process.deleted'), `${summary.deletedChars.toLocaleString()} ${t('process.chars')}`)}
        ${this.stat(t('process.deletionRatio'), ratio)}
        ${this.stat(
          t('process.executions'),
          summary.hasRunResults
            ? `${summary.executionCount} (✓${summary.runSuccessCount} ✗${summary.runFailureCount})`
            : String(summary.executionCount)
        )}
        ${this.stat(t('process.pauses'), String(summary.pauseCount))}
        ${this.stat(t('process.focusLosses'), String(summary.focusLossCount))}
        ${this.stat(t('process.externalInputs'), String(summary.externalInputCount))}
      </div>
    `;

    const notes = summary.reflectionNotes.length
      ? `<div class="process-moments-title">${t('process.reflectionNotes')}</div>
         <ul class="process-reflection-list">
           ${summary.reflectionNotes.map((n) => `<li class="process-reflection-note">${escapeHtml(n)}</li>`).join('')}
         </ul>`
      : '';

    const moments = summary.moments.length
      ? `<div class="process-moments-title">${t('process.moments')}</div>
         <ul class="process-moment-list">
           ${summary.moments.map((m) => this.renderMoment(m)).join('')}
         </ul>`
      : '';

    return stats + notes + moments;
  }

  private stat(label: string, value: string): string {
    return `
      <div class="process-stat">
        <span class="process-stat-label">${escapeHtml(label)}</span>
        <span class="process-stat-value">${escapeHtml(value)}</span>
      </div>
    `;
  }

  private renderMoment(moment: ProcessKeyMoment): string {
    return `
      <li class="process-moment">
        <span class="process-moment-kind">${this.kindLabel(moment.kind)}</span>
        <span class="process-moment-value">${this.valueLabel(moment)}</span>
        <button type="button" class="process-moment-jump" data-event-index="${moment.fromEventIndex}">
          #${moment.fromEventIndex}${moment.toEventIndex !== undefined ? `–${moment.toEventIndex}` : ''}
        </button>
      </li>
    `;
  }

  private valueLabel(moment: ProcessKeyMoment): string {
    if (moment.value === undefined) return '';
    if (moment.kind === 'longest-pause') return formatDuration(moment.value);
    return `${moment.value.toLocaleString()} ${t('process.chars')}`;
  }

  private kindLabel(kind: ProcessMomentKind): string {
    switch (kind) {
      case 'first-run':
        return t('process.kindFirstRun');
      case 'first-failed-run':
        return t('process.kindFirstFailedRun');
      case 'first-success-after-failure':
        return t('process.kindFirstSuccessAfterFailure');
      case 'longest-pause':
        return t('process.kindLongestPause');
      case 'largest-deletion':
        return t('process.kindLargestDeletion');
      case 'largest-insertion':
        return t('process.kindLargestInsertion');
      case 'focus-return-burst':
        return t('process.kindFocusBurst');
      case 'external-input':
        return t('process.kindExternalInput');
    }
  }

  private setupEventListeners(container: Element): void {
    for (const button of container.querySelectorAll<HTMLButtonElement>('.process-moment-jump')) {
      button.addEventListener('click', () => {
        const eventIndex = Number(button.dataset['eventIndex']);
        if (!Number.isFinite(eventIndex)) return;
        document.dispatchEvent(new CustomEvent('verify:seek-to-event', { detail: { eventIndex } }));
      });
    }
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
