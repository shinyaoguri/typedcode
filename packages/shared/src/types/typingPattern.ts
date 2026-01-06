/**
 * タイピングパターン分析に関する型定義
 */

// ============================================================================
// 判定結果
// ============================================================================

/** 判定結果 */
export type PatternJudgment = 'human' | 'uncertain' | 'suspicious';

/** 問題の深刻度 */
export type IssueSeverity = 'info' | 'warning' | 'critical';

// ============================================================================
// メトリクス
// ============================================================================

/** メトリクスキー */
export type MetricKey =
  | 'dwellTimeConsistency'
  | 'flightTimePattern'
  | 'rhythmRegularity'
  | 'speedVariability'
  | 'pausePattern'
  | 'burstAnalysis'
  | 'errorCorrectionPattern'
  | 'characterSpecificTiming';

/** 個別メトリクスのスコア結果 */
export interface MetricScore {
  /** メトリクス名 */
  name: string;
  /** スコア (0-100) */
  score: number;
  /** 正常範囲の閾値 */
  threshold: { min: number; max: number };
  /** 実測値 */
  actual: number;
  /** 単位 */
  unit: string;
  /** 判定結果 */
  judgment: PatternJudgment;
  /** 判定理由 */
  reason: string;
  /** 判定理由のi18nキー */
  reasonKey: string;
}

/** メトリクス分析結果 */
export type MetricAnalysis = Record<MetricKey, MetricScore>;

// ============================================================================
// 問題・警告
// ============================================================================

/** タイピングパターンの問題 */
export interface TypingPatternIssue {
  /** 深刻度 */
  severity: IssueSeverity;
  /** 関連するメトリクス */
  metric: MetricKey;
  /** メッセージ */
  message: string;
  /** メッセージのi18nキー */
  messageKey: string;
}

// ============================================================================
// 生データ統計
// ============================================================================

/** 生データ統計（チャート表示用） */
export interface TypingPatternRawStats {
  /** 全てのDwell Time (ms) */
  dwellTimes: number[];
  /** 全てのFlight Time (ms) */
  flightTimes: number[];
  /** 時系列タイピング速度 */
  typingSpeedOverTime: { timestamp: number; cps: number }[];
  /** 休止時間 (ms) */
  pauseLengths: number[];
  /** バースト長（連続タイピングの文字数） */
  burstLengths: number[];
  /** バックスペース比率 */
  backspaceRatio: number;
  /** キー別Dwell Time */
  keySpecificDwellTimes: Record<string, number[]>;
  /** 総イベント数 */
  totalEvents: number;
  /** 総タイピング時間 (ms) */
  totalTypingTime: number;
}

// ============================================================================
// 分析結果
// ============================================================================

/** タイピングパターン分析結果 */
export interface TypingPatternAnalysis {
  /** 総合スコア (0-100) */
  overallScore: number;
  /** 総合判定 */
  overallJudgment: PatternJudgment;
  /** 信頼度 (0-100) */
  confidence: number;
  /** 各メトリクスの分析結果 */
  metrics: MetricAnalysis;
  /** サマリー */
  summary: string;
  /** サマリーのi18nキー */
  summaryKey: string;
  /** 検出された問題リスト */
  issues: TypingPatternIssue[];
  /** 生データ統計 */
  rawStats: TypingPatternRawStats;
}

// ============================================================================
// 設定
// ============================================================================

/** 分析器の設定 */
export interface TypingPatternAnalyzerConfig {
  /** Dwell Time設定 */
  dwellTime: {
    /** 人間らしい最小値 (ms) */
    humanMin: number;
    /** 人間らしい最大値 (ms) */
    humanMax: number;
    /** 疑わしいほど低い変動係数 */
    suspiciousVarianceMin: number;
    /** 疑わしいほど高い変動係数 */
    suspiciousVarianceMax: number;
  };
  /** Flight Time設定 */
  flightTime: {
    /** 人間らしい最小値 (ms) */
    humanMin: number;
    /** 人間らしい最大値 (ms) */
    humanMax: number;
  };
  /** リズム変動係数設定 */
  rhythmCV: {
    /** 疑わしいほど低い値 */
    suspiciouslyLow: number;
    /** 疑わしいほど高い値 */
    suspiciouslyHigh: number;
  };
  /** 速度変動設定 */
  speedVariation: {
    /** 期待される最小変動 */
    minExpected: number;
    /** 期待される最大変動 */
    maxExpected: number;
  };
  /** 休止と見なす閾値 (ms) */
  pauseThreshold: number;
  /** バーストの最小長 (文字数) */
  burstMinLength: number;
  /** バックスペース比率設定 */
  backspaceRatio: {
    /** 人間らしい最小値 */
    humanMin: number;
    /** 人間らしい最大値 */
    humanMax: number;
  };
  /** 分析に必要な最小イベント数 */
  minEventsRequired: number;
}

/** デフォルトの分析器設定 */
export const DEFAULT_TYPING_PATTERN_ANALYZER_CONFIG: TypingPatternAnalyzerConfig = {
  dwellTime: {
    humanMin: 50,
    humanMax: 200,
    suspiciousVarianceMin: 0.1,
    suspiciousVarianceMax: 0.8,
  },
  flightTime: {
    humanMin: 30,
    humanMax: 500,
  },
  rhythmCV: {
    suspiciouslyLow: 0.1,
    suspiciouslyHigh: 1.5,
  },
  speedVariation: {
    minExpected: 0.15,
    maxExpected: 0.6,
  },
  pauseThreshold: 2000,
  burstMinLength: 5,
  backspaceRatio: {
    humanMin: 0.02,
    humanMax: 0.15,
  },
  minEventsRequired: 100,
};
