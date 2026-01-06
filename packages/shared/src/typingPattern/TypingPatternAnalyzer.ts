/**
 * TypingPatternAnalyzer - タイピングパターンから人間らしさを分析
 *
 * キーストロークダイナミクス（Dwell Time, Flight Time）や
 * タイピングリズムを分析し、人間らしいタイピングかどうかを判定する
 */

import type {
  StoredEvent,
  KeystrokeDynamicsData,
  MetricKey,
  MetricScore,
  MetricAnalysis,
  TypingPatternAnalysis,
  TypingPatternIssue,
  TypingPatternRawStats,
  TypingPatternAnalyzerConfig,
  PatternJudgment,
} from '../types/index.js';
import { DEFAULT_TYPING_PATTERN_ANALYZER_CONFIG } from '../types/typingPattern.js';

// ============================================================================
// TypingPatternAnalyzer クラス
// ============================================================================

export class TypingPatternAnalyzer {
  private config: TypingPatternAnalyzerConfig;

  constructor(config?: Partial<TypingPatternAnalyzerConfig>) {
    this.config = { ...DEFAULT_TYPING_PATTERN_ANALYZER_CONFIG, ...config };
  }

  /**
   * イベントリストからタイピングパターンを分析
   */
  analyze(events: StoredEvent[]): TypingPatternAnalysis {
    // 生データ統計を抽出
    const rawStats = this.extractRawStats(events);

    // イベント数が少ない場合は分析不可
    if (rawStats.totalEvents < this.config.minEventsRequired) {
      return this.createInsufficientDataResult(rawStats);
    }

    // 各メトリクスを計算
    const metrics = this.calculateMetrics(rawStats, events);

    // 総合スコアと判定を計算
    const { overallScore, overallJudgment, confidence } = this.calculateOverall(metrics, rawStats);

    // 問題リストを生成
    const issues = this.generateIssues(metrics);

    // サマリーを生成
    const { summary, summaryKey } = this.generateSummary(overallScore, overallJudgment, issues);

    return {
      overallScore,
      overallJudgment,
      confidence,
      metrics,
      summary,
      summaryKey,
      issues,
      rawStats,
    };
  }

  // ==========================================================================
  // 生データ抽出
  // ==========================================================================

  private extractRawStats(events: StoredEvent[]): TypingPatternRawStats {
    const dwellTimes: number[] = [];
    const flightTimes: number[] = [];
    const keySpecificDwellTimes: Record<string, number[]> = {};
    const MAX_VALID_TIME = 10000;

    let backspaceCount = 0;
    let totalKeystrokes = 0;

    // Dwell Time と Flight Time を抽出
    events.forEach((event) => {
      const data = event.data as KeystrokeDynamicsData | null;
      if (!data || typeof data !== 'object') return;

      if (event.type === 'keyUp' && 'dwellTime' in data && data.dwellTime !== undefined) {
        if (data.dwellTime >= 0 && data.dwellTime <= MAX_VALID_TIME) {
          dwellTimes.push(data.dwellTime);

          // キー別にも収集
          if (data.key) {
            const key = data.key.toLowerCase();
            if (!keySpecificDwellTimes[key]) {
              keySpecificDwellTimes[key] = [];
            }
            keySpecificDwellTimes[key].push(data.dwellTime);
          }
        }
      }

      if (event.type === 'keyDown' && 'flightTime' in data && data.flightTime !== undefined) {
        if (data.flightTime >= 0 && data.flightTime <= MAX_VALID_TIME) {
          flightTimes.push(data.flightTime);
        }
        totalKeystrokes++;

        // バックスペースをカウント
        if (data.key === 'Backspace' || data.code === 'Backspace') {
          backspaceCount++;
        }
      }
    });

    // タイピング速度の時系列データを計算
    const typingSpeedOverTime = this.calculateTypingSpeedOverTime(events);

    // 休止時間を計算
    const pauseLengths = this.extractPauseLengths(flightTimes);

    // バースト長を計算
    const burstLengths = this.calculateBurstLengths(flightTimes);

    // 総タイピング時間
    const firstEvent = events[0];
    const lastEvent = events[events.length - 1];
    const totalTypingTime =
      events.length >= 2 && firstEvent && lastEvent ? lastEvent.timestamp - firstEvent.timestamp : 0;

    return {
      dwellTimes,
      flightTimes,
      typingSpeedOverTime,
      pauseLengths,
      burstLengths,
      backspaceRatio: totalKeystrokes > 0 ? backspaceCount / totalKeystrokes : 0,
      keySpecificDwellTimes,
      totalEvents: events.length,
      totalTypingTime,
    };
  }

  private calculateTypingSpeedOverTime(
    events: StoredEvent[]
  ): { timestamp: number; cps: number }[] {
    const windowSize = 5000; // 5秒ウィンドウ
    const data: { timestamp: number; cps: number }[] = [];

    if (events.length < 2) return data;

    const firstEvent = events[0];
    const lastEvent = events[events.length - 1];
    if (!firstEvent || !lastEvent) return data;

    const totalTime = lastEvent.timestamp - firstEvent.timestamp;
    const startTime = firstEvent.timestamp;

    for (let time = 0; time <= totalTime; time += 1000) {
      const windowStart = Math.max(0, time - windowSize);
      const windowEnd = time;

      let charCount = 0;
      for (const event of events) {
        const relativeTime = event.timestamp - startTime;
        if (relativeTime >= windowStart && relativeTime <= windowEnd) {
          if (
            event.type === 'contentChange' &&
            event.data &&
            event.inputType !== 'insertFromPaste' &&
            event.inputType !== 'insertFromDrop'
          ) {
            charCount += typeof event.data === 'string' ? event.data.length : 0;
          }
        }
      }

      const speed = charCount / (windowSize / 1000);
      data.push({ timestamp: startTime + time, cps: speed });
    }

    return data;
  }

  private extractPauseLengths(flightTimes: number[]): number[] {
    return flightTimes.filter((t) => t >= this.config.pauseThreshold);
  }

  private calculateBurstLengths(flightTimes: number[]): number[] {
    const bursts: number[] = [];
    let currentBurstLength = 1;

    for (const flightTime of flightTimes) {
      if (flightTime < this.config.pauseThreshold) {
        currentBurstLength++;
      } else {
        if (currentBurstLength >= this.config.burstMinLength) {
          bursts.push(currentBurstLength);
        }
        currentBurstLength = 1;
      }
    }

    if (currentBurstLength >= this.config.burstMinLength) {
      bursts.push(currentBurstLength);
    }

    return bursts;
  }

  // ==========================================================================
  // メトリクス計算
  // ==========================================================================

  private calculateMetrics(rawStats: TypingPatternRawStats, events: StoredEvent[]): MetricAnalysis {
    return {
      dwellTimeConsistency: this.analyzeDwellTimeConsistency(rawStats.dwellTimes),
      flightTimePattern: this.analyzeFlightTimePattern(rawStats.flightTimes),
      rhythmRegularity: this.analyzeRhythmRegularity(rawStats),
      speedVariability: this.analyzeSpeedVariability(rawStats.typingSpeedOverTime),
      pausePattern: this.analyzePausePattern(rawStats.pauseLengths, rawStats.totalTypingTime),
      burstAnalysis: this.analyzeBursts(rawStats.burstLengths),
      errorCorrectionPattern: this.analyzeErrorCorrection(rawStats.backspaceRatio, events),
      characterSpecificTiming: this.analyzeCharacterSpecificTiming(rawStats.keySpecificDwellTimes),
    };
  }

  private analyzeDwellTimeConsistency(dwellTimes: number[]): MetricScore {
    if (dwellTimes.length < 10) {
      return this.createInsufficientMetric('dwellTimeConsistency', 'Dwell Time一貫性');
    }

    const mean = this.calculateMean(dwellTimes);
    const stdDev = this.calculateStdDev(dwellTimes);
    const cv = stdDev / mean; // 変動係数

    let score = 100;
    let judgment: PatternJudgment = 'human';
    let reason = 'キー押下時間の変動が自然な範囲内';
    let reasonKey = 'pattern.dwellConsistency.normal';

    if (cv < this.config.dwellTime.suspiciousVarianceMin) {
      score = 20;
      judgment = 'suspicious';
      reason = 'キー押下時間が不自然なほど一定 - 自動入力の可能性';
      reasonKey = 'pattern.dwellConsistency.tooConsistent';
    } else if (cv > this.config.dwellTime.suspiciousVarianceMax) {
      score = 50;
      judgment = 'uncertain';
      reason = 'キー押下時間の変動が大きい';
      reasonKey = 'pattern.dwellConsistency.highVariation';
    }

    return {
      name: 'Dwell Time一貫性',
      score,
      threshold: {
        min: this.config.dwellTime.suspiciousVarianceMin,
        max: this.config.dwellTime.suspiciousVarianceMax,
      },
      actual: cv,
      unit: 'CV',
      judgment,
      reason,
      reasonKey,
    };
  }

  private analyzeFlightTimePattern(flightTimes: number[]): MetricScore {
    if (flightTimes.length < 10) {
      return this.createInsufficientMetric('flightTimePattern', 'Flight Timeパターン');
    }

    const skewness = this.calculateSkewness(flightTimes);

    // 人間のFlight Timeは正のスキュー（少数の長い休止、多数の短い間隔）
    let score = 100;
    let judgment: PatternJudgment = 'human';
    let reason = 'キー間隔の分布が人間らしいパターン';
    let reasonKey = 'pattern.flightTime.normal';

    if (Math.abs(skewness) < 0.3) {
      score = 40;
      judgment = 'suspicious';
      reason = 'キー間隔が均一すぎる - 機械的なパターン';
      reasonKey = 'pattern.flightTime.tooUniform';
    } else if (skewness < 0) {
      score = 60;
      judgment = 'uncertain';
      reason = 'キー間隔の分布が通常と異なる';
      reasonKey = 'pattern.flightTime.unusual';
    }

    return {
      name: 'Flight Timeパターン',
      score,
      threshold: { min: 0.3, max: 2.0 },
      actual: skewness,
      unit: '歪度',
      judgment,
      reason,
      reasonKey,
    };
  }

  private analyzeRhythmRegularity(rawStats: TypingPatternRawStats): MetricScore {
    if (rawStats.flightTimes.length < 20) {
      return this.createInsufficientMetric('rhythmRegularity', 'リズム規則性');
    }

    const cv = this.calculateCV(rawStats.flightTimes);
    const autocorr = this.calculateAutocorrelation(rawStats.flightTimes, 1);

    let score = 100;
    let judgment: PatternJudgment = 'human';
    let reason = 'タイピングリズムに自然な変動あり';
    let reasonKey = 'pattern.rhythm.normal';

    if (cv < this.config.rhythmCV.suspiciouslyLow) {
      score = 25;
      judgment = 'suspicious';
      reason = 'タイピングリズムが不自然なほど一定';
      reasonKey = 'pattern.rhythm.tooConsistent';
    } else if (autocorr > 0.7) {
      score = 35;
      judgment = 'suspicious';
      reason = '周期的なパターンを検出 - 自動入力の疑い';
      reasonKey = 'pattern.rhythm.periodic';
    } else if (cv > this.config.rhythmCV.suspiciouslyHigh) {
      score = 60;
      judgment = 'uncertain';
      reason = 'タイピングリズムの変動が大きい';
      reasonKey = 'pattern.rhythm.highVariation';
    }

    return {
      name: 'リズム規則性',
      score,
      threshold: {
        min: this.config.rhythmCV.suspiciouslyLow,
        max: this.config.rhythmCV.suspiciouslyHigh,
      },
      actual: cv,
      unit: 'CV',
      judgment,
      reason,
      reasonKey,
    };
  }

  private analyzeSpeedVariability(
    speedOverTime: { timestamp: number; cps: number }[]
  ): MetricScore {
    if (speedOverTime.length < 5) {
      return this.createInsufficientMetric('speedVariability', '速度変動');
    }

    const speeds = speedOverTime.map((s) => s.cps).filter((s) => s > 0);
    if (speeds.length < 3) {
      return this.createInsufficientMetric('speedVariability', '速度変動');
    }

    const cv = this.calculateCV(speeds);

    let score = 100;
    let judgment: PatternJudgment = 'human';
    let reason = 'タイピング速度に自然な変動あり';
    let reasonKey = 'pattern.speed.normal';

    if (cv < this.config.speedVariation.minExpected) {
      score = 30;
      judgment = 'suspicious';
      reason = 'タイピング速度が不自然なほど一定';
      reasonKey = 'pattern.speed.tooConsistent';
    } else if (cv > this.config.speedVariation.maxExpected) {
      score = 65;
      judgment = 'uncertain';
      reason = 'タイピング速度の変動が大きい';
      reasonKey = 'pattern.speed.highVariation';
    }

    return {
      name: '速度変動',
      score,
      threshold: {
        min: this.config.speedVariation.minExpected,
        max: this.config.speedVariation.maxExpected,
      },
      actual: cv,
      unit: 'CV',
      judgment,
      reason,
      reasonKey,
    };
  }

  private analyzePausePattern(pauseLengths: number[], totalTime: number): MetricScore {
    const pauseCount = pauseLengths.length;
    const minutesTyping = totalTime / 60000;
    const pausesPerMinute = minutesTyping > 0 ? pauseCount / minutesTyping : 0;

    let score = 100;
    let judgment: PatternJudgment = 'human';
    let reason = '自然な休止パターン';
    let reasonKey = 'pattern.pause.normal';

    if (pauseCount === 0 && totalTime > 60000) {
      score = 35;
      judgment = 'suspicious';
      reason = '長時間タイピングで休止なし - 不自然';
      reasonKey = 'pattern.pause.noPauses';
    } else if (pausesPerMinute > 15) {
      score = 55;
      judgment = 'uncertain';
      reason = '休止が多すぎる';
      reasonKey = 'pattern.pause.tooMany';
    }

    return {
      name: '休止パターン',
      score,
      threshold: { min: 1, max: 10 },
      actual: pausesPerMinute,
      unit: '回/分',
      judgment,
      reason,
      reasonKey,
    };
  }

  private analyzeBursts(burstLengths: number[]): MetricScore {
    if (burstLengths.length < 3) {
      return this.createInsufficientMetric('burstAnalysis', 'バースト分析');
    }

    const mean = this.calculateMean(burstLengths);
    const cv = this.calculateCV(burstLengths);

    let score = 100;
    let judgment: PatternJudgment = 'human';
    let reason = '連続タイピングのパターンが自然';
    let reasonKey = 'pattern.burst.normal';

    if (cv < 0.15) {
      score = 30;
      judgment = 'suspicious';
      reason = 'バースト長が不自然なほど均一';
      reasonKey = 'pattern.burst.tooUniform';
    } else if (mean > 100) {
      score = 50;
      judgment = 'uncertain';
      reason = '休止なしの長い連続タイピング';
      reasonKey = 'pattern.burst.tooLong';
    }

    return {
      name: 'バースト分析',
      score,
      threshold: { min: 0.2, max: 0.8 },
      actual: cv,
      unit: 'CV',
      judgment,
      reason,
      reasonKey,
    };
  }

  private analyzeErrorCorrection(backspaceRatio: number, _events: StoredEvent[]): MetricScore {
    let score = 100;
    let judgment: PatternJudgment = 'human';
    let reason = '適度なエラー修正パターン';
    let reasonKey = 'pattern.error.normal';

    if (backspaceRatio < this.config.backspaceRatio.humanMin) {
      score = 40;
      judgment = 'suspicious';
      reason = 'エラー修正がほぼない - 不自然';
      reasonKey = 'pattern.error.noCorrections';
    } else if (backspaceRatio > this.config.backspaceRatio.humanMax) {
      score = 60;
      judgment = 'uncertain';
      reason = 'エラー修正が多い';
      reasonKey = 'pattern.error.tooMany';
    }

    return {
      name: 'エラー修正パターン',
      score,
      threshold: {
        min: this.config.backspaceRatio.humanMin,
        max: this.config.backspaceRatio.humanMax,
      },
      actual: backspaceRatio,
      unit: '比率',
      judgment,
      reason,
      reasonKey,
    };
  }

  private analyzeCharacterSpecificTiming(
    keySpecificDwellTimes: Record<string, number[]>
  ): MetricScore {
    const slowKeys = ['a', 'q', 'z', ';', 'p', '/', "'"];
    const fastKeys = ['f', 'j', 'd', 'k', 's', 'l'];

    let slowKeyAvg = 0;
    let fastKeyAvg = 0;
    let slowCount = 0;
    let fastCount = 0;

    for (const [key, times] of Object.entries(keySpecificDwellTimes)) {
      if (times.length < 3) continue;
      const avg = this.calculateMean(times);

      if (slowKeys.includes(key)) {
        slowKeyAvg += avg;
        slowCount++;
      } else if (fastKeys.includes(key)) {
        fastKeyAvg += avg;
        fastCount++;
      }
    }

    if (slowCount < 2 || fastCount < 2) {
      return this.createInsufficientMetric('characterSpecificTiming', 'キー別タイミング');
    }

    slowKeyAvg /= slowCount;
    fastKeyAvg /= fastCount;

    const ratio = slowKeyAvg / fastKeyAvg;

    let score = 100;
    let judgment: PatternJudgment = 'human';
    let reason = 'キー位置による押下時間の違いが自然';
    let reasonKey = 'pattern.charTiming.normal';

    if (Math.abs(ratio - 1) < 0.1) {
      score = 45;
      judgment = 'suspicious';
      reason = '全キーの押下時間が均一 - 不自然';
      reasonKey = 'pattern.charTiming.tooUniform';
    }

    return {
      name: 'キー別タイミング',
      score,
      threshold: { min: 1.1, max: 1.5 },
      actual: ratio,
      unit: '比率',
      judgment,
      reason,
      reasonKey,
    };
  }

  // ==========================================================================
  // 総合判定
  // ==========================================================================

  private calculateOverall(
    metrics: MetricAnalysis,
    rawStats: TypingPatternRawStats
  ): { overallScore: number; overallJudgment: PatternJudgment; confidence: number } {
    const weights: Record<MetricKey, number> = {
      dwellTimeConsistency: 0.15,
      flightTimePattern: 0.15,
      rhythmRegularity: 0.20,
      speedVariability: 0.15,
      pausePattern: 0.10,
      burstAnalysis: 0.10,
      errorCorrectionPattern: 0.10,
      characterSpecificTiming: 0.05,
    };

    let weightedSum = 0;
    let totalWeight = 0;

    for (const [key, weight] of Object.entries(weights)) {
      const metric = metrics[key as MetricKey];
      weightedSum += metric.score * weight;
      totalWeight += weight;
    }

    const overallScore = Math.round(weightedSum / totalWeight);

    let overallJudgment: PatternJudgment;
    if (overallScore >= 70) {
      overallJudgment = 'human';
    } else if (overallScore >= 40) {
      overallJudgment = 'uncertain';
    } else {
      overallJudgment = 'suspicious';
    }

    // 信頼度はデータ量に依存
    const confidence = Math.min(
      100,
      Math.round((rawStats.totalEvents / 500) * 100)
    );

    return { overallScore, overallJudgment, confidence };
  }

  private generateIssues(metrics: MetricAnalysis): TypingPatternIssue[] {
    const issues: TypingPatternIssue[] = [];

    for (const [key, metric] of Object.entries(metrics)) {
      if (metric.judgment === 'suspicious') {
        issues.push({
          severity: 'critical',
          metric: key as MetricKey,
          message: metric.reason,
          messageKey: metric.reasonKey,
        });
      } else if (metric.judgment === 'uncertain') {
        issues.push({
          severity: 'warning',
          metric: key as MetricKey,
          message: metric.reason,
          messageKey: metric.reasonKey,
        });
      }
    }

    return issues;
  }

  private generateSummary(
    _overallScore: number,
    overallJudgment: PatternJudgment,
    issues: TypingPatternIssue[]
  ): { summary: string; summaryKey: string } {
    const criticalCount = issues.filter((i) => i.severity === 'critical').length;
    const warningCount = issues.filter((i) => i.severity === 'warning').length;

    let summary: string;
    let summaryKey: string;

    if (overallJudgment === 'human') {
      summary = 'タイピングパターンは人間らしい特徴を示しています';
      summaryKey = 'pattern.summary.human';
    } else if (overallJudgment === 'suspicious') {
      summary = `自動入力や不正入力の可能性があります (${criticalCount}件の重大な問題)`;
      summaryKey = 'pattern.summary.suspicious';
    } else {
      summary = `一部のパターンに不明確な点があります (${warningCount}件の警告)`;
      summaryKey = 'pattern.summary.uncertain';
    }

    return { summary, summaryKey };
  }

  // ==========================================================================
  // ヘルパー関数
  // ==========================================================================

  private createInsufficientDataResult(rawStats: TypingPatternRawStats): TypingPatternAnalysis {
    const emptyMetric = (name: string): MetricScore => ({
      name,
      score: 50,
      threshold: { min: 0, max: 0 },
      actual: 0,
      unit: '-',
      judgment: 'uncertain',
      reason: 'データ不足のため分析不可',
      reasonKey: 'pattern.insufficient',
    });

    return {
      overallScore: 50,
      overallJudgment: 'uncertain',
      confidence: 0,
      metrics: {
        dwellTimeConsistency: emptyMetric('Dwell Time一貫性'),
        flightTimePattern: emptyMetric('Flight Timeパターン'),
        rhythmRegularity: emptyMetric('リズム規則性'),
        speedVariability: emptyMetric('速度変動'),
        pausePattern: emptyMetric('休止パターン'),
        burstAnalysis: emptyMetric('バースト分析'),
        errorCorrectionPattern: emptyMetric('エラー修正パターン'),
        characterSpecificTiming: emptyMetric('キー別タイミング'),
      },
      summary: `分析に必要なイベント数（${this.config.minEventsRequired}件以上）が不足しています`,
      summaryKey: 'pattern.summary.insufficientData',
      issues: [],
      rawStats,
    };
  }

  private createInsufficientMetric(_key: MetricKey, name: string): MetricScore {
    return {
      name,
      score: 50,
      threshold: { min: 0, max: 0 },
      actual: 0,
      unit: '-',
      judgment: 'uncertain',
      reason: 'データ不足',
      reasonKey: 'pattern.insufficient',
    };
  }

  private calculateMean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  private calculateStdDev(values: number[]): number {
    if (values.length < 2) return 0;
    const mean = this.calculateMean(values);
    const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
    return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / values.length);
  }

  private calculateCV(values: number[]): number {
    const mean = this.calculateMean(values);
    if (mean === 0) return 0;
    return this.calculateStdDev(values) / mean;
  }

  private calculateSkewness(values: number[]): number {
    if (values.length < 3) return 0;
    const mean = this.calculateMean(values);
    const stdDev = this.calculateStdDev(values);
    if (stdDev === 0) return 0;

    const n = values.length;
    const sum = values.reduce((acc, v) => acc + Math.pow((v - mean) / stdDev, 3), 0);
    return (n / ((n - 1) * (n - 2))) * sum;
  }

  private calculateAutocorrelation(values: number[], lag: number): number {
    if (values.length < lag + 2) return 0;
    const mean = this.calculateMean(values);
    let numerator = 0;
    let denominator = 0;

    for (let i = 0; i < values.length - lag; i++) {
      const val = values[i];
      const lagVal = values[i + lag];
      if (val !== undefined && lagVal !== undefined) {
        numerator += (val - mean) * (lagVal - mean);
      }
    }

    for (let i = 0; i < values.length; i++) {
      const val = values[i];
      if (val !== undefined) {
        denominator += Math.pow(val - mean, 2);
      }
    }

    return denominator === 0 ? 0 : numerator / denominator;
  }
}
