/**
 * AnalysisReportCard - 分析層 (ADR-0009) の advisory レポートを表示するカード
 *
 * 重要: ここに出すのは「判定」ではなく「人間レビューの手掛かり」。
 * - 暗号検証 (valid/invalid) とは独立軸 — このカードの内容は検証結果に影響しない
 * - 各 signal の evidence (event index) はクリックでシークバーの当該位置へジャンプし、
 *   採点者が現場を検分できるようにする (ADR-0009 の証拠リンク必須要件)
 */

import { escapeHtml, type AnalysisReport, type AnalysisSignal, type AnalysisDimension, type AnalysisSeverity, type EvidenceRef } from '@typedcode/shared';
import { t } from '../i18n/index.js';

export class AnalysisReportCard {
  private cardElement: HTMLElement | null = null;

  show(): void {
    this.cardElement = document.getElementById('card-analysis');
    if (this.cardElement) {
      this.cardElement.style.display = '';
    }
  }

  hide(): void {
    this.cardElement = document.getElementById('card-analysis');
    if (this.cardElement) {
      this.cardElement.style.display = 'none';
    }
  }

  render(report: AnalysisReport): void {
    this.show();
    this.cardElement = document.getElementById('card-analysis');
    if (!this.cardElement) return;

    const icon = this.cardElement.querySelector('#analysis-icon');
    const badge = this.cardElement.querySelector('#analysis-badge');
    const content = this.cardElement.querySelector('#analysis-content');

    // advisory なので error クラスは使わない: review/notice あり → warning、無し → success。
    const notable = report.signals.filter((s) => s.severity !== 'info');
    const stateClass = notable.length > 0 ? 'warning' : 'success';

    if (icon) {
      icon.className = `result-card-icon ${stateClass}`;
    }
    if (badge) {
      badge.className = `result-card-badge ${stateClass}`;
      badge.textContent =
        notable.length > 0
          ? `${t('analysis.reviewPriority')} ${(report.reviewPriority * 100).toFixed(0)}%`
          : t('analysis.noSignals');
    }
    if (content) {
      content.innerHTML = this.renderContent(report);
      this.setupEventListeners(content);
    }
  }

  private renderContent(report: AnalysisReport): string {
    const signals = report.signals.length
      ? `<ul class="analysis-signal-list">${report.signals.map((s) => this.renderSignal(s)).join('')}</ul>`
      : `<div class="analysis-no-signals">${t('analysis.noSignals')}</div>`;

    const versions = Object.entries(report.analyzerVersions)
      .map(([id, v]) => `${escapeHtml(id)}@${escapeHtml(v)}`)
      .join(', ');

    return `
      <div class="analysis-advisory-note">
        <i class="fas fa-info-circle"></i>
        <span>${t('analysis.advisory')}</span>
      </div>
      ${signals}
      <div class="analysis-versions">${t('analysis.analyzers')}: ${versions}</div>
    `;
  }

  private renderSignal(signal: AnalysisSignal): string {
    const sevClass = signal.severity === 'info' ? 'info' : 'warning';
    const evidence = signal.evidence.map((ev) => this.renderEvidence(ev)).join('');
    return `
      <li class="analysis-signal ${sevClass}">
        <div class="analysis-signal-header">
          <span class="analysis-severity ${sevClass}">${this.severityLabel(signal.severity)}</span>
          <span class="analysis-dimension">${this.dimensionLabel(signal.dimension)}</span>
          <span class="analysis-scores">
            ${t('analysis.score')} ${(signal.score * 100).toFixed(0)} ·
            ${t('analysis.confidence')} ${(signal.confidence * 100).toFixed(0)}%
          </span>
        </div>
        <div class="analysis-summary">${escapeHtml(signal.summary)}</div>
        ${evidence ? `<div class="analysis-evidence-row"><span class="analysis-evidence-label">${t('analysis.evidence')}:</span>${evidence}</div>` : ''}
      </li>
    `;
  }

  private renderEvidence(ev: EvidenceRef): string {
    const label =
      ev.toEventIndex !== undefined && ev.toEventIndex !== ev.fromEventIndex
        ? `#${ev.fromEventIndex}–${ev.toEventIndex}`
        : `#${ev.fromEventIndex}`;
    const note = ev.note ? ` title="${escapeHtml(ev.note)}"` : '';
    return `<button type="button" class="analysis-evidence-link" data-event-index="${ev.fromEventIndex}"${note}>${label}</button>`;
  }

  private setupEventListeners(container: Element): void {
    for (const button of container.querySelectorAll<HTMLButtonElement>('.analysis-evidence-link')) {
      button.addEventListener('click', () => {
        const eventIndex = Number(button.dataset['eventIndex']);
        if (!Number.isFinite(eventIndex)) return;
        // ChartController が listen し、シークバーを当該イベントへ移動する。
        document.dispatchEvent(
          new CustomEvent('verify:seek-to-event', { detail: { eventIndex } })
        );
      });
    }
  }

  private severityLabel(severity: AnalysisSeverity): string {
    switch (severity) {
      case 'review':
        return t('analysis.severityReview');
      case 'notice':
        return t('analysis.severityNotice');
      default:
        return t('analysis.severityInfo');
    }
  }

  private dimensionLabel(dimension: AnalysisDimension): string {
    switch (dimension) {
      case 'automation':
        return t('analysis.dimensionAutomation');
      case 'keystroke-content-consistency':
        return t('analysis.dimensionKeystrokeContent');
      case 'transcription-topology':
        return t('analysis.dimensionTranscriptionTopology');
      case 'focus-burst-correlation':
        return t('analysis.dimensionFocusBurst');
    }
  }
}
