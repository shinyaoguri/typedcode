/**
 * TypingPatternCard - タイピングパターン分析結果を表示するUIコンポーネント
 */

import type {
  TypingPatternAnalysis,
  MetricScore,
  MetricKey,
  TypingPatternIssue,
  PatternJudgment,
  IssueSeverity,
} from '@typedcode/shared';
import { t } from '../i18n/index.js';

// ============================================================================
// TypingPatternCard クラス
// ============================================================================

export class TypingPatternCard {
  private cardElement: HTMLElement | null = null;
  private isExpanded = false;

  /**
   * カードを表示
   */
  show(): void {
    this.cardElement = document.getElementById('card-typing-pattern');
    if (this.cardElement) {
      this.cardElement.style.display = '';
    }
  }

  /**
   * カードを非表示
   */
  hide(): void {
    this.cardElement = document.getElementById('card-typing-pattern');
    if (this.cardElement) {
      this.cardElement.style.display = 'none';
    }
  }

  /**
   * 分析結果をレンダリング
   */
  render(analysis: TypingPatternAnalysis): void {
    this.show();
    this.cardElement = document.getElementById('card-typing-pattern');
    if (!this.cardElement) return;

    // アイコンとバッジを更新
    const icon = this.cardElement.querySelector('#pattern-icon');
    const badge = this.cardElement.querySelector('#pattern-badge');
    const content = this.cardElement.querySelector('#pattern-content');

    if (icon) {
      icon.className = `result-card-icon ${this.getJudgmentClass(analysis.overallJudgment)}`;
    }

    if (badge) {
      badge.className = `result-card-badge ${this.getJudgmentClass(analysis.overallJudgment)}`;
      badge.textContent = this.getJudgmentLabel(analysis.overallJudgment);
    }

    if (content) {
      content.innerHTML = this.renderContent(analysis);
      this.setupEventListeners(content);
    }
  }

  /**
   * コンテンツをレンダリング
   */
  private renderContent(analysis: TypingPatternAnalysis): string {
    return `
      <div class="pattern-overview">
        <div class="pattern-gauge-container">
          ${this.renderGauge(analysis.overallScore, analysis.overallJudgment)}
        </div>
        <div class="pattern-summary-container">
          <div class="pattern-summary">${analysis.summary}</div>
          <div class="pattern-confidence">
            <span class="confidence-label">${t('pattern.confidence') || '信頼度'}:</span>
            <span class="confidence-value">${analysis.confidence}%</span>
          </div>
        </div>
      </div>

      ${analysis.issues.length > 0 ? this.renderIssues(analysis.issues) : ''}

      <div class="pattern-metrics-section">
        <button class="pattern-metrics-toggle" id="pattern-metrics-toggle">
          <span>${t('pattern.detailedAnalysis') || '詳細分析'}</span>
          <i class="fas fa-chevron-down"></i>
        </button>
        <div class="pattern-metrics ${this.isExpanded ? 'expanded' : ''}" id="pattern-metrics">
          ${this.renderMetrics(analysis.metrics)}
        </div>
      </div>
    `;
  }

  /**
   * スコアゲージをレンダリング
   */
  private renderGauge(score: number, judgment: PatternJudgment): string {
    const radius = 36;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (score / 100) * circumference;
    const colorClass = this.getJudgmentClass(judgment);

    return `
      <svg class="pattern-gauge" viewBox="0 0 100 100">
        <circle class="gauge-bg" cx="50" cy="50" r="${radius}" />
        <circle class="gauge-fill ${colorClass}"
                cx="50" cy="50" r="${radius}"
                stroke-dasharray="${circumference}"
                stroke-dashoffset="${offset}" />
        <text x="50" y="45" text-anchor="middle" class="gauge-score">${score}</text>
        <text x="50" y="62" text-anchor="middle" class="gauge-label">${t('pattern.score') || 'スコア'}</text>
      </svg>
    `;
  }

  /**
   * 問題リストをレンダリング
   */
  private renderIssues(issues: TypingPatternIssue[]): string {
    const criticalIssues = issues.filter((i) => i.severity === 'critical');
    const warningIssues = issues.filter((i) => i.severity === 'warning');

    let html = '<div class="pattern-issues">';

    if (criticalIssues.length > 0) {
      html += `
        <div class="issues-group critical">
          <div class="issues-header">
            <i class="fas fa-exclamation-circle"></i>
            <span>${t('pattern.criticalIssues') || '重大な問題'} (${criticalIssues.length})</span>
          </div>
          <ul class="issues-list">
            ${criticalIssues.map((i) => `<li>${i.message}</li>`).join('')}
          </ul>
        </div>
      `;
    }

    if (warningIssues.length > 0) {
      html += `
        <div class="issues-group warning">
          <div class="issues-header">
            <i class="fas fa-exclamation-triangle"></i>
            <span>${t('pattern.warnings') || '警告'} (${warningIssues.length})</span>
          </div>
          <ul class="issues-list">
            ${warningIssues.map((i) => `<li>${i.message}</li>`).join('')}
          </ul>
        </div>
      `;
    }

    html += '</div>';
    return html;
  }

  /**
   * メトリクスをレンダリング
   */
  private renderMetrics(metrics: Record<MetricKey, MetricScore>): string {
    const metricOrder: MetricKey[] = [
      'rhythmRegularity',
      'dwellTimeConsistency',
      'flightTimePattern',
      'speedVariability',
      'pausePattern',
      'burstAnalysis',
      'errorCorrectionPattern',
      'characterSpecificTiming',
    ];

    return metricOrder
      .map((key) => this.renderMetricRow(key, metrics[key]))
      .join('');
  }

  /**
   * メトリクス行をレンダリング
   */
  private renderMetricRow(key: MetricKey, metric: MetricScore): string {
    const judgmentClass = this.getJudgmentClass(metric.judgment);
    const description = this.getMetricDescription(key);

    return `
      <div class="metric-row ${judgmentClass}">
        <div class="metric-header">
          <span class="metric-name">
            ${metric.name}
            <span class="metric-info-icon" data-tooltip="${this.escapeHtml(description)}">
              <i class="fas fa-info-circle"></i>
              <div class="metric-tooltip">${description}</div>
            </span>
          </span>
          <span class="metric-indicator ${judgmentClass}">
            <i class="fas ${this.getJudgmentIcon(metric.judgment)}"></i>
          </span>
        </div>
        <div class="metric-bar-container">
          <div class="metric-bar">
            <div class="metric-bar-fill" style="width: ${metric.score}%; background: ${this.getScoreColor(metric.score)}"></div>
          </div>
          <span class="metric-score" style="color: ${this.getScoreColor(metric.score)}">${metric.score}</span>
        </div>
        <div class="metric-detail">
          <span class="metric-value">${metric.actual.toFixed(2)} ${metric.unit}</span>
          <span class="metric-reason">${metric.reason}</span>
        </div>
      </div>
    `;
  }

  /**
   * HTMLエスケープ
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * 指標の説明を取得
   */
  private getMetricDescription(key: MetricKey): string {
    const descriptions: Record<MetricKey, string> = {
      rhythmRegularity: 'タイピングのリズム（キー入力間隔）の規則性を分析。人間は自然なばらつきがあり、機械的な入力は一定のリズムになりやすい。',
      dwellTimeConsistency: 'キーを押してから離すまでの時間（Dwell Time）のばらつきを分析。人間は指や疲労により変動するが、自動入力は一定になりやすい。',
      flightTimePattern: '連続するキー入力間の時間（Flight Time）の分布パターンを分析。人間は短い間隔が多く、長い休止が少ない正のスキューを示す。',
      speedVariability: 'タイピング速度の変化を分析。人間は考え中に遅くなり、慣れた部分で速くなる自然な変動を示す。',
      pausePattern: '休止（長めの入力間隔）のパターンを分析。人間は文章の区切りや思考時に自然な休止を入れる。',
      burstAnalysis: '連続タイピング（バースト）の長さを分析。人間は5-30文字程度のバーストを示し、均一なバースト長は機械的な特徴。',
      errorCorrectionPattern: 'バックスペースによるエラー修正のパターンを分析。人間は2-15%程度のエラー修正を行い、修正なしは不自然。',
      characterSpecificTiming: 'キーの位置による入力時間の違いを分析。人間は小指キーが遅く、ホームポジションが速いなどの特徴を示す。',
    };
    return descriptions[key] || '';
  }

  /**
   * イベントリスナーをセットアップ
   */
  private setupEventListeners(container: Element): void {
    const toggle = container.querySelector('#pattern-metrics-toggle');
    const metrics = container.querySelector('#pattern-metrics');

    if (toggle && metrics) {
      toggle.addEventListener('click', () => {
        this.isExpanded = !this.isExpanded;
        metrics.classList.toggle('expanded', this.isExpanded);
        toggle.classList.toggle('expanded', this.isExpanded);
      });
    }
  }

  // ==========================================================================
  // ヘルパー関数
  // ==========================================================================

  private getJudgmentClass(judgment: PatternJudgment): string {
    switch (judgment) {
      case 'human':
        return 'success';
      case 'uncertain':
        return 'warning';
      case 'suspicious':
        return 'error';
      default:
        return 'pending';
    }
  }

  private getJudgmentLabel(judgment: PatternJudgment): string {
    switch (judgment) {
      case 'human':
        return t('pattern.human') || '人間らしい';
      case 'uncertain':
        return t('pattern.uncertain') || '不明確';
      case 'suspicious':
        return t('pattern.suspicious') || '疑わしい';
      default:
        return '-';
    }
  }

  private getJudgmentIcon(judgment: PatternJudgment): string {
    switch (judgment) {
      case 'human':
        return 'fa-check';
      case 'uncertain':
        return 'fa-question';
      case 'suspicious':
        return 'fa-times';
      default:
        return 'fa-minus';
    }
  }

  /**
   * スコアに応じた色を取得（0-100のスコアに対してグラデーション）
   * 0-40: 赤 → 60-80: 黄 → 80-100: 緑
   */
  private getScoreColor(score: number): string {
    // 色の定義 (RGB)
    const red = { r: 239, g: 68, b: 68 };     // #ef4444
    const yellow = { r: 251, g: 191, b: 36 }; // #fbbf24
    const green = { r: 34, g: 197, b: 94 };   // #22c55e

    let r: number, g: number, b: number;

    if (score <= 50) {
      // 0-50: 赤から黄へ
      const t = score / 50;
      r = Math.round(red.r + (yellow.r - red.r) * t);
      g = Math.round(red.g + (yellow.g - red.g) * t);
      b = Math.round(red.b + (yellow.b - red.b) * t);
    } else {
      // 50-100: 黄から緑へ
      const t = (score - 50) / 50;
      r = Math.round(yellow.r + (green.r - yellow.r) * t);
      g = Math.round(yellow.g + (green.g - yellow.g) * t);
      b = Math.round(yellow.b + (green.b - yellow.b) * t);
    }

    return `rgb(${r}, ${g}, ${b})`;
  }
}
