/**
 * ResultPanel - Verification result display with cards
 */
import type {
  VerificationResult,
  PoswStats,
  HumanAttestationUI,
  VerificationStepType,
  VerificationStepStatus,
  TrustResult,
  TrustIssue,
  TrustLevel,
  DiffResult,
  ChainErrorDetails,
  SampledVerificationInfo,
} from '../types';
import { escapeHtml, type TypingPatternAnalysis } from '@typedcode/shared';
import { SyntaxHighlighter } from '../services/SyntaxHighlighter.js';
import { TypingPatternCard } from './TypingPatternCard.js';
import { t } from '../i18n/index.js';

export interface ResultData {
  filename: string;
  content: string;
  language: string;
  result: VerificationResult;
  poswStats?: PoswStats;
  attestations?: HumanAttestationUI[];
  eventCount: number;
  typingTime: string;
  typingSpeed: string;
  trustResult?: TrustResult;
  typingPatternAnalysis?: TypingPatternAnalysis;
}

export interface PlaintextData {
  filename: string;
  content: string;
  language: string;
  /** 差分計算結果 */
  diffResult?: DiffResult;
  /** ソースファイルと証明内容が異なるかどうか */
  hasContentMismatch?: boolean;
}

export interface ImageData {
  filename: string;
  imageBlob?: Blob;
}

export class ResultPanel {
  private container: HTMLElement;
  private loading: HTMLElement;
  private content: HTMLElement;
  private plaintextContent: HTMLElement;
  private plaintextFilename: HTMLElement;
  private plaintextLanguage: HTMLElement;
  private plaintextCode: HTMLElement;

  // Status card
  private statusIcon: HTMLElement;
  private statusTitle: HTMLElement;
  private statusFilename: HTMLElement;
  private statusPattern: HTMLElement;
  private patternMiniGauge: HTMLElement;
  private patternMiniJudgment: HTMLElement;

  // Verification cards
  private typingIcon: HTMLElement;
  private typingBadge: HTMLElement;
  private pasteCount: HTMLElement;
  private externalInput: HTMLElement;
  private cardTyping: HTMLElement;

  private chainIcon: HTMLElement;
  private chainBadge: HTMLElement;
  private chainMethod: HTMLElement;
  private chainEvents: HTMLElement;
  private cardChain: HTMLElement;
  private screenshotVerificationRow: HTMLElement;
  private screenshotVerification: HTMLElement;
  // Chain error details
  private chainErrorDetails: HTMLElement;
  private chainErrorPosition: HTMLElement;
  private chainErrorType: HTMLElement;
  private chainErrorMessage: HTMLElement;
  private chainErrorExpectedRow: HTMLElement;
  private chainErrorExpected: HTMLElement;
  private chainErrorComputedRow: HTMLElement;
  private chainErrorComputed: HTMLElement;
  private chainErrorTimestampRow: HTMLElement;
  private chainErrorTimestamp: HTMLElement;
  // Chain segment visualization
  private chainSegmentViz: HTMLElement;
  private chainSegmentBar: HTMLElement;
  private chainSegmentTotal: HTMLElement;
  private chainSegmentInfo: HTMLElement;

  private poswIcon: HTMLElement;
  private poswBadge: HTMLElement;
  private poswIterations: HTMLElement;
  private poswTotalTime: HTMLElement;
  private cardPosw: HTMLElement;

  private attestationIcon: HTMLElement;
  private attestationBadge: HTMLElement;
  private attestationCreate: HTMLElement;
  private attestationExport: HTMLElement;
  private attestationCreateRow: HTMLElement;
  private attestationExportRow: HTMLElement;
  private cardAttestation: HTMLElement;

  // Stats
  private statEvents: HTMLElement;
  private statTime: HTMLElement;
  private statSpeed: HTMLElement;

  // Code preview
  private codePreview: HTMLElement;

  // Typing pattern card
  private typingPatternCard: TypingPatternCard;

  // Chart tabs
  private tabIntegrated: HTMLElement;
  private tabTimeline: HTMLElement;
  private tabMouse: HTMLElement;
  private panelIntegrated: HTMLElement;
  private panelTimeline: HTMLElement;
  private panelMouse: HTMLElement;

  // Chart stats
  private keydownCount: HTMLElement;
  private avgDwellTime: HTMLElement;
  private avgFlightTime: HTMLElement;
  private mouseEventCount: HTMLElement;

  // Verification progress elements
  private vpFilename: HTMLElement;
  private vpOverallFill: HTMLElement;
  private vpOverallPercent: HTMLElement;
  private vpOverallTime: HTMLElement;
  private vpSteps: HTMLElement;
  private vpDetail: HTMLElement;
  private vpDetailText: HTMLElement;
  private progressStartTime: number = 0;
  private progressTimerInterval: number | null = null;

  constructor() {
    this.container = document.getElementById('result-container')!;
    this.loading = document.getElementById('result-loading')!;
    this.content = document.getElementById('result-content')!;

    // Plaintext elements
    this.plaintextContent = document.getElementById('plaintext-content')!;
    this.plaintextFilename = document.getElementById('plaintext-filename')!;
    this.plaintextLanguage = document.getElementById('plaintext-language')!;
    this.plaintextCode = document.getElementById('plaintext-code')!;

    // Status card
    this.statusIcon = document.getElementById('result-status-icon')!;
    this.statusTitle = document.getElementById('result-status-title')!;
    this.statusFilename = document.getElementById('result-status-filename')!;
    this.statusPattern = document.getElementById('result-status-pattern')!;
    this.patternMiniGauge = document.getElementById('pattern-mini-gauge')!;
    this.patternMiniJudgment = document.getElementById('pattern-mini-judgment')!;

    // Typing card
    this.cardTyping = document.getElementById('card-typing')!;
    this.typingIcon = document.getElementById('typing-icon')!;
    this.typingBadge = document.getElementById('typing-badge')!;
    this.pasteCount = document.getElementById('paste-count')!;
    this.externalInput = document.getElementById('external-input')!;

    // Chain card
    this.cardChain = document.getElementById('card-chain')!;
    this.chainIcon = document.getElementById('chain-icon')!;
    this.chainBadge = document.getElementById('chain-badge')!;
    this.chainMethod = document.getElementById('chain-method')!;
    this.chainEvents = document.getElementById('chain-events')!;
    this.screenshotVerificationRow = document.getElementById('screenshot-verification-row')!;
    this.screenshotVerification = document.getElementById('screenshot-verification')!;
    // Chain error details
    this.chainErrorDetails = document.getElementById('chain-error-details')!;
    this.chainErrorPosition = document.getElementById('chain-error-position')!;
    this.chainErrorType = document.getElementById('chain-error-type')!;
    this.chainErrorMessage = document.getElementById('chain-error-message')!;
    this.chainErrorExpectedRow = document.getElementById('chain-error-expected-row')!;
    this.chainErrorExpected = document.getElementById('chain-error-expected')!;
    this.chainErrorComputedRow = document.getElementById('chain-error-computed-row')!;
    this.chainErrorComputed = document.getElementById('chain-error-computed')!;
    this.chainErrorTimestampRow = document.getElementById('chain-error-timestamp-row')!;
    this.chainErrorTimestamp = document.getElementById('chain-error-timestamp')!;
    // Chain segment visualization
    this.chainSegmentViz = document.getElementById('chain-segment-viz')!;
    this.chainSegmentBar = document.getElementById('chain-segment-bar')!;
    this.chainSegmentTotal = document.getElementById('chain-segment-total')!;
    this.chainSegmentInfo = document.getElementById('chain-segment-info')!;

    // PoSW card
    this.cardPosw = document.getElementById('card-posw')!;
    this.poswIcon = document.getElementById('posw-icon')!;
    this.poswBadge = document.getElementById('posw-badge')!;
    this.poswIterations = document.getElementById('posw-iterations')!;
    this.poswTotalTime = document.getElementById('posw-total-time')!;

    // Attestation card
    this.cardAttestation = document.getElementById('card-attestation')!;
    this.attestationIcon = document.getElementById('attestation-icon')!;
    this.attestationBadge = document.getElementById('attestation-badge')!;
    this.attestationCreate = document.getElementById('attestation-create')!;
    this.attestationExport = document.getElementById('attestation-export')!;
    this.attestationCreateRow = document.getElementById('attestation-create-row')!;
    this.attestationExportRow = document.getElementById('attestation-export-row')!;

    // Stats
    this.statEvents = document.getElementById('stat-events')!;
    this.statTime = document.getElementById('stat-time')!;
    this.statSpeed = document.getElementById('stat-speed')!;

    // Code preview
    this.codePreview = document.getElementById('code-preview')!;

    // Typing pattern card
    this.typingPatternCard = new TypingPatternCard();

    // Chart tabs
    this.tabIntegrated = document.getElementById('tab-integrated')!;
    this.tabTimeline = document.getElementById('tab-timeline')!;
    this.tabMouse = document.getElementById('tab-mouse')!;
    this.panelIntegrated = document.getElementById('panel-integrated')!;
    this.panelTimeline = document.getElementById('panel-timeline')!;
    this.panelMouse = document.getElementById('panel-mouse')!;

    // Chart stats
    this.keydownCount = document.getElementById('keydown-count')!;
    this.avgDwellTime = document.getElementById('avg-dwell-time')!;
    this.avgFlightTime = document.getElementById('avg-flight-time')!;
    this.mouseEventCount = document.getElementById('mouse-event-count')!;

    // Verification progress elements
    this.vpFilename = document.getElementById('vp-filename')!;
    this.vpOverallFill = document.getElementById('vp-overall-fill')!;
    this.vpOverallPercent = document.getElementById('vp-overall-percent')!;
    this.vpOverallTime = document.getElementById('vp-overall-time')!;
    this.vpSteps = document.getElementById('vp-steps')!;
    this.vpDetail = document.getElementById('vp-detail')!;
    this.vpDetailText = document.getElementById('vp-detail-text')!;

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    // Card expansion toggle
    const cards = document.querySelectorAll('.result-card-header');
    cards.forEach((header) => {
      header.addEventListener('click', () => {
        const card = header.closest('.result-card');
        card?.classList.toggle('expanded');
      });
    });

    // Chart tabs
    this.tabIntegrated.addEventListener('click', () => {
      this.setActiveChartTab('integrated');
    });

    this.tabTimeline.addEventListener('click', () => {
      this.setActiveChartTab('timeline');
    });

    this.tabMouse.addEventListener('click', () => {
      this.setActiveChartTab('mouse');
    });
  }

  private setActiveChartTab(tab: 'integrated' | 'timeline' | 'mouse'): void {
    this.tabIntegrated.classList.toggle('active', tab === 'integrated');
    this.tabTimeline.classList.toggle('active', tab === 'timeline');
    this.tabMouse.classList.toggle('active', tab === 'mouse');
    this.panelIntegrated.classList.toggle('active', tab === 'integrated');
    this.panelTimeline.classList.toggle('active', tab === 'timeline');
    this.panelMouse.classList.toggle('active', tab === 'mouse');
  }

  show(): void {
    this.container.style.display = 'flex';
  }

  hide(): void {
    this.container.style.display = 'none';
  }

  showLoading(): void {
    this.loading.style.display = 'flex';
    this.content.style.display = 'none';
    this.plaintextContent.style.display = 'none';
  }

  showContent(): void {
    this.loading.style.display = 'none';
    this.content.style.display = 'flex';
    this.plaintextContent.style.display = 'none';
  }

  showPlaintext(): void {
    this.loading.style.display = 'none';
    this.content.style.display = 'none';
    this.plaintextContent.style.display = 'flex';
  }

  /**
   * プレーンテキストファイルを表示（読み取り専用）
   * 差分がある場合はGitHub風の差分表示を行う
   */
  renderPlaintext(data: PlaintextData): void {
    this.plaintextFilename.textContent = data.filename;
    this.plaintextLanguage.textContent = data.language;

    // 既存の警告バナーをクリア
    this.clearDiffWarningBanner();

    const codeEl = this.plaintextCode.querySelector('code');
    if (codeEl) {
      if (data.hasContentMismatch && data.diffResult) {
        // 差分がある場合: 警告バナー + 差分ビュー
        this.showDiffWarningBanner(data.diffResult.stats);
        codeEl.innerHTML = this.renderDiffView(data.diffResult);
        codeEl.className = 'diff-view';
      } else {
        // 差分がない場合: 通常のシンタックスハイライト
        const highlighted = SyntaxHighlighter.highlight(data.content, data.language);
        codeEl.innerHTML = highlighted;
        codeEl.className = `language-${data.language} hljs`;
      }
    }

    this.show();
    this.showPlaintext();
  }

  /**
   * 差分警告バナーを表示
   */
  private showDiffWarningBanner(stats: { additions: number; deletions: number }): void {
    const banner = document.createElement('div');
    banner.className = 'diff-warning-banner';
    banner.id = 'diff-warning-banner';
    banner.innerHTML = `
      <i class="fas fa-exclamation-triangle"></i>
      <span>ソースファイルと証明内容が一致しません</span>
      <span class="diff-stats">
        <span class="diff-additions">+${stats.additions}</span>
        <span class="diff-deletions">-${stats.deletions}</span>
      </span>
    `;

    // ヘッダーの後に挿入
    const header = this.plaintextContent.querySelector('.plaintext-header');
    if (header) {
      header.after(banner);
    }
  }

  /**
   * 差分警告バナーをクリア
   */
  private clearDiffWarningBanner(): void {
    const existing = document.getElementById('diff-warning-banner');
    if (existing) {
      existing.remove();
    }
  }

  /**
   * 差分ビューをHTML形式でレンダリング
   */
  private renderDiffView(diffResult: DiffResult): string {
    const lines: string[] = [];

    for (const hunk of diffResult.hunks) {
      for (const line of hunk.lines) {
        const lineNum = line.type === 'removed'
          ? (line.oldLineNumber?.toString().padStart(4, ' ') || '    ')
          : (line.newLineNumber?.toString().padStart(4, ' ') || '    ');

        const prefix = line.type === 'added' ? '+'
          : line.type === 'removed' ? '-'
          : ' ';

        const className = `diff-line diff-${line.type}`;
        const escapedContent = escapeHtml(line.content);

        lines.push(`<div class="${className}"><span class="diff-line-number">${lineNum}</span><span class="diff-prefix">${prefix}</span><span class="diff-content">${escapedContent}</span></div>`);
      }
    }

    return lines.join('');
  }

  /**
   * 画像ファイルを表示
   */
  renderImage(data: ImageData): void {
    this.plaintextFilename.textContent = data.filename;
    this.plaintextLanguage.textContent = 'IMAGE';

    const codeEl = this.plaintextCode.querySelector('code');
    if (codeEl) {
      // 画像プレビューを表示
      if (data.imageBlob) {
        const url = URL.createObjectURL(data.imageBlob);
        codeEl.innerHTML = `
          <div class="image-preview-container">
            <img src="${url}" alt="${data.filename}" class="image-preview" onload="URL.revokeObjectURL(this.src)" />
          </div>
        `;
      } else {
        codeEl.innerHTML = '<p style="color: var(--text-tertiary);">画像を読み込めませんでした</p>';
      }
      codeEl.className = '';
    }

    this.show();
    this.showPlaintext();
  }

  render(data: ResultData): void {
    const { filename, content, language, result, poswStats, attestations, eventCount, typingTime, typingSpeed, trustResult } = data;

    // Overall status - TrustResult を優先使用
    if (trustResult) {
      this.renderTrustBadge(trustResult);
    } else {
      // フォールバック: 従来のロジック
      const isSuccess = result.chainValid && result.pureTyping;
      const isWarning = result.chainValid && !result.pureTyping;
      const statusClass = isSuccess ? 'success' : isWarning ? 'warning' : 'error';

      this.statusIcon.className = `result-status-icon ${statusClass}`;
      this.statusIcon.innerHTML = `<i class="fas fa-${isSuccess ? 'check-circle' : isWarning ? 'exclamation-triangle' : 'times-circle'}"></i>`;
      this.statusTitle.textContent = isSuccess ? '検証成功' : isWarning ? '警告あり' : '検証失敗';
    }
    this.statusFilename.textContent = filename;

    // Typing card
    this.renderCard(
      this.typingIcon,
      this.typingBadge,
      result.pureTyping,
      result.pureTyping ? '純粋' : '外部入力あり'
    );
    this.pasteCount.textContent = `${result.pasteCount || 0}回`;
    this.externalInput.textContent = result.pureTyping ? 'なし' : 'あり';

    // Chain card
    this.renderCard(
      this.chainIcon,
      this.chainBadge,
      result.chainValid,
      result.chainValid ? '有効' : '無効'
    );
    this.chainMethod.textContent = result.verificationMethod || 'standard';
    this.chainEvents.textContent = `${eventCount.toLocaleString()}件`;

    // Chain error details (show only when verification fails)
    this.renderChainErrorDetails(result.chainErrorDetails);

    // Chain segment visualization (show for sampled verification)
    this.renderChainSegmentViz(result.sampledVerification, eventCount, result.chainErrorDetails);

    // PoSW card
    const hasPoSW = poswStats && poswStats.totalIterations > 0;
    this.renderCard(
      this.poswIcon,
      this.poswBadge,
      hasPoSW ? true : null,
      hasPoSW ? '有効' : 'なし'
    );
    this.poswIterations.textContent = hasPoSW ? poswStats.totalIterations.toLocaleString() : '-';
    this.poswTotalTime.textContent = hasPoSW ? `${Math.round(poswStats.totalTime)}ms` : '-';

    // Attestation card
    if (attestations && attestations.length > 0) {
      this.cardAttestation.style.display = 'block';
      const createAttestation = attestations.find((a) => a.type === 'create' || a.eventIndex === 0);
      const exportAttestation = attestations.find((a) => a.type === 'export' || (a.eventIndex && a.eventIndex > 0));

      let validCount = 0;
      if (createAttestation?.valid) validCount++;
      if (exportAttestation?.valid) validCount++;

      this.renderCard(
        this.attestationIcon,
        this.attestationBadge,
        validCount === attestations.length,
        `${validCount}/${attestations.length} 有効`
      );

      if (createAttestation) {
        this.attestationCreateRow.style.display = 'flex';
        this.attestationCreate.textContent = createAttestation.valid ? '✓ 有効' : '✗ 無効';
        this.attestationCreate.className = `result-row-value ${createAttestation.valid ? 'text-success' : 'text-danger'}`;
      } else {
        this.attestationCreateRow.style.display = 'none';
      }

      if (exportAttestation) {
        this.attestationExportRow.style.display = 'flex';
        this.attestationExport.textContent = exportAttestation.valid ? '✓ 有効' : '✗ 無効';
        this.attestationExport.className = `result-row-value ${exportAttestation.valid ? 'text-success' : 'text-danger'}`;
      } else {
        this.attestationExportRow.style.display = 'none';
      }
    } else {
      this.cardAttestation.style.display = 'none';
    }

    // Typing pattern - mini gauge in status card and full card
    if (data.typingPatternAnalysis) {
      this.renderPatternMiniGauge(data.typingPatternAnalysis);
      this.typingPatternCard.render(data.typingPatternAnalysis);
    } else {
      this.statusPattern.style.display = 'none';
      this.typingPatternCard.hide();
    }

    // Stats
    this.statEvents.textContent = eventCount.toLocaleString();
    this.statTime.textContent = typingTime;
    this.statSpeed.textContent = typingSpeed;

    // Code preview with syntax highlighting and line numbers
    const codeEl = this.codePreview.querySelector('code');
    if (codeEl) {
      const highlighted = SyntaxHighlighter.highlight(content, language);
      const withLineNumbers = SyntaxHighlighter.addLineNumbers(highlighted);
      codeEl.innerHTML = withLineNumbers;
      codeEl.className = `language-${language} hljs with-line-numbers`;
    }

    this.showContent();
  }

  private renderCard(
    iconEl: HTMLElement,
    badgeEl: HTMLElement,
    isValid: boolean | null,
    badgeText: string
  ): void {
    const statusClass = isValid === null ? 'pending' : isValid ? 'success' : 'error';
    iconEl.className = `result-card-icon ${statusClass}`;
    badgeEl.className = `result-card-badge ${statusClass}`;
    badgeEl.textContent = badgeText;
  }

  updateChartStats(stats: {
    keydownCount: number;
    avgDwellTime: number;
    avgFlightTime: number;
    mouseEventCount: number;
  }): void {
    this.keydownCount.textContent = stats.keydownCount.toString();
    this.avgDwellTime.textContent = `${Math.round(stats.avgDwellTime)}ms`;
    this.avgFlightTime.textContent = `${Math.round(stats.avgFlightTime)}ms`;
    this.mouseEventCount.textContent = stats.mouseEventCount.toString();
  }

  /**
   * スクリーンショット検証結果を表示
   */
  updateScreenshotVerification(screenshots: { total: number; verified: number; missing?: number }): void {
    if (screenshots.total === 0) {
      this.screenshotVerificationRow.style.display = 'none';
      return;
    }

    this.screenshotVerificationRow.style.display = '';

    const missingCount = screenshots.missing ?? 0;
    const tamperedCount = screenshots.total - screenshots.verified - missingCount;

    if (missingCount === 0 && tamperedCount === 0) {
      // 全て検証済み
      this.screenshotVerification.innerHTML = `<span class="success">✓ ${screenshots.verified}/${screenshots.total}枚検証済み</span>`;
    } else if (missingCount > 0 && tamperedCount === 0) {
      // 欠損ファイルあり（改ざんなし）
      this.screenshotVerification.innerHTML = `<span class="error">✗ ${missingCount}/${screenshots.total}枚が欠損</span>`;
    } else if (missingCount === 0 && tamperedCount > 0) {
      // 改ざんの可能性あり
      this.screenshotVerification.innerHTML = `<span class="warning">⚠ ${tamperedCount}/${screenshots.total}枚が改ざんの可能性</span>`;
    } else {
      // 欠損と改ざん両方
      this.screenshotVerification.innerHTML = `<span class="error">✗ ${missingCount}枚欠損, ${tamperedCount}枚改ざんの可能性</span>`;
    }
  }

  reset(): void {
    // Reset all cards to pending state
    const icons = [this.typingIcon, this.chainIcon, this.poswIcon, this.attestationIcon];
    const badges = [this.typingBadge, this.chainBadge, this.poswBadge, this.attestationBadge];

    icons.forEach((icon) => {
      icon.className = 'result-card-icon pending';
    });

    badges.forEach((badge) => {
      badge.className = 'result-card-badge pending';
      badge.textContent = '-';
    });

    // Reset status
    this.statusIcon.className = 'result-status-icon';
    this.statusIcon.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    this.statusTitle.textContent = '検証中...';
    this.statusFilename.textContent = '';

    // Reset stats
    this.statEvents.textContent = '-';
    this.statTime.textContent = '-';
    this.statSpeed.textContent = '-';

    // Reset code preview
    const codeEl = this.codePreview.querySelector('code');
    if (codeEl) {
      codeEl.textContent = '';
    }

    // Collapse all cards
    document.querySelectorAll('.result-card').forEach((card) => {
      card.classList.remove('expanded');
    });
  }

  // ============================================================================
  // 検証進捗表示メソッド
  // ============================================================================

  /**
   * 検証進捗表示を開始（ファイル名を設定してタイマーを開始）
   */
  startProgress(filename: string): void {
    this.vpFilename.textContent = filename;
    this.vpOverallFill.style.width = '0%';
    this.vpOverallPercent.textContent = '0%';
    this.vpOverallTime.textContent = '0:00';

    // 全ステップをペンディング状態にリセット
    this.resetProgressSteps();

    // タイマー開始
    this.progressStartTime = Date.now();
    this.stopProgressTimer();
    this.progressTimerInterval = window.setInterval(() => {
      this.updateElapsedTime();
    }, 100);

    this.show();
    this.showLoading();
  }

  /**
   * 進捗タイマーを停止
   */
  stopProgressTimer(): void {
    if (this.progressTimerInterval !== null) {
      clearInterval(this.progressTimerInterval);
      this.progressTimerInterval = null;
    }
  }

  /**
   * 経過時間を更新
   */
  private updateElapsedTime(): void {
    const elapsed = Date.now() - this.progressStartTime;
    const seconds = Math.floor(elapsed / 1000);
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    this.vpOverallTime.textContent = `${minutes}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * 全体進捗を更新
   */
  updateOverallProgress(percent: number): void {
    const clampedPercent = Math.max(0, Math.min(100, percent));
    this.vpOverallFill.style.width = `${clampedPercent}%`;
    this.vpOverallPercent.textContent = `${Math.round(clampedPercent)}%`;
  }

  // ステップ状態のキャッシュ（不要な再描画を防止）
  private stepStatusCache: Map<VerificationStepType, VerificationStepStatus> = new Map();

  /**
   * ステップの状態を更新（状態が変わった場合のみ再描画）
   */
  updateStepStatus(
    step: VerificationStepType,
    status: VerificationStepStatus,
    statusText?: string
  ): void {
    // 状態が変わっていない場合はスキップ（チカチカ防止）
    const cachedStatus = this.stepStatusCache.get(step);
    if (cachedStatus === status && !statusText) {
      return;
    }
    this.stepStatusCache.set(step, status);

    const stepEl = document.getElementById(`vp-step-${step}`);
    const iconEl = stepEl?.querySelector('.vp-step-icon');
    const statusEl = document.getElementById(`vp-status-${step}`);

    if (!stepEl || !iconEl) return;

    // data-status属性を設定（CSS用）
    stepEl.dataset.status = status;

    // アイコンのクラスを更新
    iconEl.className = `vp-step-icon ${status}`;

    // アイコンを状態に応じて変更
    const iconMap: Record<VerificationStepStatus, string> = {
      pending: this.getStepIcon(step),
      running: 'fa-spinner fa-spin',
      success: 'fa-check',
      error: 'fa-times',
      skipped: 'fa-minus',
    };
    iconEl.innerHTML = `<i class="fas ${iconMap[status]}"></i>`;

    // 完了したステップの接続線を更新
    if (status === 'success') {
      stepEl.classList.add('completed');
    } else {
      stepEl.classList.remove('completed');
    }

    // ステータステキストを更新
    if (statusEl && statusText) {
      statusEl.textContent = statusText;
    } else if (statusEl) {
      const defaultStatusText: Record<VerificationStepStatus, string> = {
        pending: '',
        running: '処理中...',
        success: '完了',
        error: 'エラー',
        skipped: 'スキップ',
      };
      statusEl.textContent = defaultStatusText[status];
    }
  }

  /**
   * ステップの進捗バーを更新
   */
  updateStepProgress(step: VerificationStepType, percent: number, detail?: string): void {
    const progressEl = document.getElementById(`vp-progress-${step}`);
    if (!progressEl) return;

    progressEl.style.display = 'flex';

    const fillEl = progressEl.querySelector('.vp-step-fill') as HTMLElement;
    const detailEl = progressEl.querySelector('.vp-step-detail') as HTMLElement;

    if (fillEl) {
      fillEl.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    }

    if (detailEl && detail) {
      detailEl.textContent = detail;
    }
  }

  /**
   * 詳細パネルを表示
   */
  showProgressDetail(text: string): void {
    this.vpDetail.style.display = 'block';
    this.vpDetailText.textContent = text;
  }

  /**
   * 詳細パネルを非表示
   */
  hideProgressDetail(): void {
    this.vpDetail.style.display = 'none';
  }

  /**
   * ステップのデフォルトアイコンを取得
   */
  private getStepIcon(step: VerificationStepType): string {
    const iconMap: Record<VerificationStepType, string> = {
      metadata: 'fa-file-circle-check',
      chain: 'fa-link',
      sampling: 'fa-layer-group',
      complete: 'fa-check-double',
    };
    return iconMap[step];
  }

  /**
   * 全ステップをペンディング状態にリセット
   */
  private resetProgressSteps(): void {
    // ステータスキャッシュをクリア
    this.stepStatusCache.clear();

    const steps: VerificationStepType[] = ['metadata', 'chain', 'sampling', 'complete'];

    steps.forEach((step) => {
      const stepEl = document.getElementById(`vp-step-${step}`);
      const iconEl = stepEl?.querySelector('.vp-step-icon');
      const statusEl = document.getElementById(`vp-status-${step}`);
      const progressEl = document.getElementById(`vp-progress-${step}`);

      if (stepEl) {
        stepEl.dataset.status = 'pending';
        stepEl.classList.remove('completed');
        // chainステップはデフォルト非表示（フォールバック時のみ表示）
        if (step === 'chain') {
          stepEl.style.display = 'none';
        }
      }

      if (iconEl) {
        iconEl.className = 'vp-step-icon pending';
        iconEl.innerHTML = `<i class="fas ${this.getStepIcon(step)}"></i>`;
      }

      if (statusEl) {
        statusEl.textContent = '';
      }

      if (progressEl) {
        progressEl.style.display = 'none';
        const fillEl = progressEl.querySelector('.vp-step-fill') as HTMLElement;
        if (fillEl) {
          fillEl.style.width = '0%';
        }
      }
    });

    this.hideProgressDetail();
  }

  /**
   * フォールバック時にchainステップを表示
   */
  showFallbackStep(): void {
    const chainEl = document.getElementById('vp-step-chain');
    if (chainEl) {
      chainEl.style.display = '';
    }
  }

  /**
   * 検証完了時の処理
   */
  finishProgress(): void {
    this.stopProgressTimer();
    this.updateOverallProgress(100);
    this.updateStepStatus('complete', 'success', '完了');
  }

  /**
   * 検証エラー時の処理
   */
  errorProgress(step: VerificationStepType, errorMessage?: string): void {
    this.stopProgressTimer();
    this.updateStepStatus(step, 'error', 'エラー');
    if (errorMessage) {
      this.showProgressDetail(errorMessage);
    }
  }

  // ============================================================================
  // 信頼度表示メソッド
  // ============================================================================

  /**
   * 信頼度バッジを描画
   */
  private renderTrustBadge(trustResult: TrustResult): void {
    const colorMap: Record<TrustLevel, string> = {
      verified: 'success',
      partial: 'warning',
      failed: 'error',
    };
    const iconMap: Record<TrustLevel, string> = {
      verified: 'check-circle',
      partial: 'exclamation-triangle',
      failed: 'times-circle',
    };

    const { level, summary, issues } = trustResult;

    this.statusIcon.className = `result-status-icon ${colorMap[level]}`;
    this.statusIcon.innerHTML = `<i class="fas fa-${iconMap[level]}"></i>`;
    this.statusTitle.textContent = summary;

    // イシューリストの表示
    if (issues.length > 0) {
      this.renderIssuesList(issues);
    } else {
      this.clearIssuesList();
    }
  }

  /**
   * イシューリストを描画
   */
  private renderIssuesList(issues: TrustIssue[]): void {
    // 既存のイシューリストを削除
    this.clearIssuesList();

    // イシューリストコンテナを作成
    const issuesContainer = document.createElement('div');
    issuesContainer.className = 'trust-issues';
    issuesContainer.id = 'trust-issues-list';

    for (const issue of issues) {
      const issueEl = document.createElement('div');
      issueEl.className = `trust-issue-item ${issue.severity}`;

      const iconClass = issue.severity === 'error' ? 'fa-times-circle' : 'fa-exclamation-triangle';
      issueEl.innerHTML = `
        <i class="fas ${iconClass}"></i>
        <span class="trust-issue-component">${this.getComponentLabel(issue.component)}</span>
        <span class="trust-issue-message">${issue.message}</span>
      `;

      issuesContainer.appendChild(issueEl);
    }

    // ステータスカードの後に挿入
    const statusCard = document.getElementById('result-status-card');
    if (statusCard) {
      statusCard.after(issuesContainer);
    }
  }

  /**
   * イシューリストをクリア
   */
  private clearIssuesList(): void {
    const existing = document.getElementById('trust-issues-list');
    if (existing) {
      existing.remove();
    }
  }

  /**
   * コンポーネント名のラベルを取得
   */
  private getComponentLabel(component: string): string {
    const labels: Record<string, string> = {
      metadata: 'メタデータ',
      chain: 'ハッシュチェーン',
      posw: 'PoSW',
      attestation: '人間証明',
      screenshots: 'スクリーンショット',
      source: 'ソースファイル',
    };
    return labels[component] || component;
  }

  /**
   * チェーン検証エラー詳細を表示
   */
  private renderChainErrorDetails(details?: ChainErrorDetails): void {
    if (!details) {
      this.chainErrorDetails.style.display = 'none';
      return;
    }

    this.chainErrorDetails.style.display = 'block';

    // エラー位置
    const position = `${details.errorAt.toLocaleString()} / ${details.totalEvents.toLocaleString()} (${((details.errorAt / details.totalEvents) * 100).toFixed(1)}%)`;
    this.chainErrorPosition.textContent = position;

    // エラー種別 (use i18n translations)
    const errorTypeKey = `chain.errorDetails.errorTypes.${details.errorType}` as const;
    const errorTypeLabel = t(errorTypeKey) || details.errorType;
    this.chainErrorType.textContent = errorTypeLabel;

    // エラーメッセージ
    this.chainErrorMessage.textContent = details.message;

    // ハッシュ値（存在する場合のみ表示）
    if (details.expectedHash) {
      this.chainErrorExpectedRow.style.display = 'flex';
      this.chainErrorExpected.textContent = details.expectedHash;
    } else {
      this.chainErrorExpectedRow.style.display = 'none';
    }

    if (details.computedHash) {
      this.chainErrorComputedRow.style.display = 'flex';
      this.chainErrorComputed.textContent = details.computedHash;
    } else {
      this.chainErrorComputedRow.style.display = 'none';
    }

    // タイムスタンプ詳細（タイムスタンプエラーの場合のみ）
    if (details.errorType === 'timestamp' && details.previousTimestamp !== undefined && details.currentTimestamp !== undefined) {
      this.chainErrorTimestampRow.style.display = 'flex';
      this.chainErrorTimestamp.textContent = `${details.previousTimestamp.toFixed(2)}ms → ${details.currentTimestamp.toFixed(2)}ms`;
    } else {
      this.chainErrorTimestampRow.style.display = 'none';
    }
  }

  /**
   * サンプリング区間を視覚化
   */
  private renderChainSegmentViz(
    sampledInfo?: SampledVerificationInfo,
    totalEvents?: number,
    errorDetails?: ChainErrorDetails
  ): void {
    // サンプリング検証がない場合は非表示
    if (!sampledInfo || sampledInfo.segments.length === 0) {
      this.chainSegmentViz.style.display = 'none';
      return;
    }

    this.chainSegmentViz.style.display = 'block';

    const total = sampledInfo.totalEvents || totalEvents || 1;
    this.chainSegmentTotal.textContent = total.toLocaleString();

    // セグメントバーをクリア
    this.chainSegmentBar.innerHTML = '';

    // 検証済み区間とそれ以外を描画
    const segments = sampledInfo.segments;
    let lastEndIndex = 0;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];

      // 前の区間との隙間（未検証区間）を描画
      if (segment.startIndex > lastEndIndex) {
        const gapStart = (lastEndIndex / total) * 100;
        const gapWidth = ((segment.startIndex - lastEndIndex) / total) * 100;
        const gapEl = document.createElement('div');
        gapEl.className = 'chain-segment unverified';
        gapEl.style.left = `${gapStart}%`;
        gapEl.style.width = `${gapWidth}%`;
        this.chainSegmentBar.appendChild(gapEl);
      }

      // サンプリング区間を描画
      const startPercent = (segment.startIndex / total) * 100;
      const widthPercent = ((segment.endIndex - segment.startIndex) / total) * 100;

      const segmentEl = document.createElement('div');
      segmentEl.className = `chain-segment ${segment.verified ? 'verified' : 'error'}`;
      segmentEl.style.left = `${startPercent}%`;
      segmentEl.style.width = `${Math.max(widthPercent, 0.5)}%`; // 最小幅を確保

      // ツールチップを追加
      const tooltipEl = document.createElement('div');
      tooltipEl.className = 'chain-segment-tooltip';
      tooltipEl.textContent = `${segment.startIndex.toLocaleString()} - ${segment.endIndex.toLocaleString()} (${segment.eventCount.toLocaleString()})`;
      segmentEl.appendChild(tooltipEl);

      this.chainSegmentBar.appendChild(segmentEl);
      lastEndIndex = segment.endIndex;
    }

    // 最後の区間の後の隙間（未検証区間）を描画
    if (lastEndIndex < total) {
      const gapStart = (lastEndIndex / total) * 100;
      const gapWidth = ((total - lastEndIndex) / total) * 100;
      const gapEl = document.createElement('div');
      gapEl.className = 'chain-segment unverified';
      gapEl.style.left = `${gapStart}%`;
      gapEl.style.width = `${gapWidth}%`;
      this.chainSegmentBar.appendChild(gapEl);
    }

    // エラー位置のマーカーを追加
    if (errorDetails && errorDetails.errorAt !== undefined) {
      const errorPercent = (errorDetails.errorAt / total) * 100;
      const errorMarker = document.createElement('div');
      errorMarker.className = 'chain-segment-error-marker';
      errorMarker.style.left = `${errorPercent}%`;
      errorMarker.title = `Error at event ${errorDetails.errorAt.toLocaleString()}`;
      this.chainSegmentBar.appendChild(errorMarker);
    }

    // サマリー情報を表示
    this.chainSegmentInfo.innerHTML = `
      <div class="chain-segment-info-summary">
        <span class="chain-segment-info-item">
          <strong>${sampledInfo.totalEventsVerified.toLocaleString()}</strong> / ${sampledInfo.totalEvents.toLocaleString()} ${t('chain.events') || 'events'}
        </span>
        <span class="chain-segment-info-item">
          ${t('chain.segmentViz.sampledSegments', {
            count: sampledInfo.segments.length.toString(),
            total: sampledInfo.totalSegments.toString(),
          }) || `${sampledInfo.segments.length}/${sampledInfo.totalSegments} segments`}
        </span>
      </div>
    `;
  }

  // ============================================================================
  // タイピングパターンミニゲージ
  // ============================================================================

  /**
   * ステータスカードにタイピングパターンのミニゲージを表示
   */
  private renderPatternMiniGauge(analysis: TypingPatternAnalysis): void {
    this.statusPattern.style.display = 'flex';

    const { overallScore, overallJudgment } = analysis;

    // 判定に応じた色クラス
    const colorClass = this.getPatternJudgmentClass(overallJudgment);

    // ミニゲージ（SVG）
    const radius = 20;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (overallScore / 100) * circumference;

    this.patternMiniGauge.innerHTML = `
      <svg class="pattern-mini-svg" viewBox="0 0 50 50">
        <circle class="gauge-bg" cx="25" cy="25" r="${radius}" />
        <circle class="gauge-fill ${colorClass}"
                cx="25" cy="25" r="${radius}"
                stroke-dasharray="${circumference}"
                stroke-dashoffset="${offset}" />
        <text x="25" y="28" text-anchor="middle" class="gauge-score">${overallScore}</text>
      </svg>
    `;

    // 判定ラベル
    const judgmentLabels: Record<string, string> = {
      human: '人間らしい',
      uncertain: '不明確',
      suspicious: '疑わしい',
    };
    this.patternMiniJudgment.textContent = judgmentLabels[overallJudgment] || '-';
    this.patternMiniJudgment.className = `pattern-mini-judgment ${colorClass}`;
  }

  /**
   * タイピングパターンの判定に応じたCSSクラスを取得
   */
  private getPatternJudgmentClass(judgment: string): string {
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
}
