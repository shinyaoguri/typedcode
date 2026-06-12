/**
 * 三層保証語彙 (ADR-0020)
 *
 * proof が読み手 (採点者・検証者) に与える保証を、強度の異なる 3 つの独立した層として
 * 機械導出する。**自己申告ラベル (proof.mode) は入力に使わず、実証拠のみから導く**
 * (ADR-0011 §6 の宿題)。
 *
 * - 整合性 (integrity):   記録は事後改変されていないか — 暗号検証、決定的
 * - 時刻アンカー (temporal): 記録はいつ存在したか — サーバ署名 / T0 束縛、決定的
 * - 著述性 (provenance):  打鍵が転写でなく著述に見えるか — **常に advisory**。
 *                          レベルを持たず、判定に昇格させてはならない (ADR-0009)
 *
 * 重要な不変条件:
 * - provenance は何があっても integrity / temporal に影響しない (直交)
 * - 本導出は verifyProofFile の valid を置き換えない (表示語彙の導出であって判定ではない)
 */

/** 整合性: 暗号検証の結果。二値 (決定的)。 */
export type IntegrityLevel = 'proven' | 'failed';

/**
 * 時刻アンカー: 記録の存在時刻がどの程度固定されているか。
 * - anchored:   root サーバアンカー + 署名 cp が密 (申告セッション全体が時刻固定)
 * - partial:    何らかのサーバアンカーはあるが弱い (疎 / post-hoc 疑い / root か cp の片方のみ)
 * - unanchored: サーバ由来の時刻証拠なし (完全オフライン捏造の余地)
 * - exam-t0:    試験 proof。T0 束縛 (封印 + 監督コード) が時刻の regime を担う (ADR-0006)
 */
export type TemporalLevel = 'anchored' | 'partial' | 'unanchored' | 'exam-t0';

/** 著述性: レベルを持たない advisory サマリ。判定に使ってはならない。 */
export interface ProvenanceAdvisory {
  /** ペースト/ドロップ等の外部入力が無いか (入力出自、ADR-0005)。 */
  pureTyping: boolean;
  /** severity が info を超える分析シグナル数 (ADR-0009)。分析未実行は null。 */
  notableSignals: number | null;
  /** 分析の要確認度 0..1 (ADR-0009)。分析未実行は null。 */
  reviewPriority: number | null;
}

export interface AssuranceResult {
  integrity: IntegrityLevel;
  temporal: TemporalLevel;
  provenance: ProvenanceAdvisory;
}

/** 導出に必要な最小の実証拠。UI 固有型に依存しない (verify / verify-cli 両方から使う)。 */
export interface AssuranceInput {
  /** メタデータ整合 (typingProofHash / root / metadata 再カウント)。 */
  metadataValid: boolean;
  /** ハッシュチェーン整合 (finalHash / content replay / checkpoint 含む複合)。 */
  chainValid: boolean;
  /** 改竄が検出されたスクリーンショット数 (検証していない場合は省略)。 */
  screenshotsTampered?: number;
  /** 試験 proof の束縛 (ADR-0006)。 */
  exam?: {
    present: boolean;
    packageProvided: boolean;
    /** package 提供時のみ意味を持つ。 */
    bindingValid?: boolean;
  };
  /** root がサーバアンカーされているか (ADR-0017)。 */
  rootAnchored: boolean;
  /** 署名チェックポイント (ADR-0002/0016)。無ければ省略。 */
  signedCheckpoints?: {
    anchored: boolean;
    valid?: boolean;
    sparse?: boolean;
    postHocSuspected?: boolean;
  };
  /** ピュアタイピング (外部入力なし)。 */
  isPureTyping: boolean;
  /** 分析レポートのサマリ (ADR-0009)。分析未実行は省略。 */
  analysis?: {
    reviewPriority: number;
    notableSignals: number;
  };
}

/**
 * 実証拠から三層保証を導出する。
 */
export function deriveAssurance(input: AssuranceInput): AssuranceResult {
  // --- 整合性: 暗号検証はどれか 1 つでも破れたら failed (二値・決定的)。
  const examBindingFailed =
    input.exam?.present === true &&
    input.exam.packageProvided &&
    input.exam.bindingValid === false;
  const integrity: IntegrityLevel =
    input.metadataValid &&
    input.chainValid &&
    (input.screenshotsTampered ?? 0) === 0 &&
    !examBindingFailed
      ? 'proven'
      : 'failed';

  // --- 時刻アンカー
  const temporal = deriveTemporal(input);

  // --- 著述性: 常に advisory。レベル化しない。
  const provenance: ProvenanceAdvisory = {
    pureTyping: input.isPureTyping,
    notableSignals: input.analysis ? input.analysis.notableSignals : null,
    reviewPriority: input.analysis ? input.analysis.reviewPriority : null,
  };

  return { integrity, temporal, provenance };
}

function deriveTemporal(input: AssuranceInput): TemporalLevel {
  // 試験 proof は T0 束縛 (封印 + 監督コード = proctor) が時刻 regime を担う (ADR-0006)。
  // 署名 cp は best-effort の補強であり、有無で regime は変わらない。
  if (input.exam?.present) {
    return 'exam-t0';
  }

  const sc = input.signedCheckpoints;
  // 有効な署名 cp 連鎖があるか (anchored だが invalid は時刻証拠として数えない)
  const hasValidCheckpoints = sc?.anchored === true && sc.valid !== false;
  const checkpointsClean =
    hasValidCheckpoints && sc?.sparse !== true && sc?.postHocSuspected !== true;

  if (input.rootAnchored && checkpointsClean) {
    return 'anchored';
  }
  if (input.rootAnchored || hasValidCheckpoints) {
    // 片方のみ / 疎 / post-hoc 疑い — 何らかのサーバ時刻証拠はある
    return 'partial';
  }
  return 'unanchored';
}

/**
 * AnalysisReport から AssuranceInput.analysis を作るヘルパ。
 * notableSignals = severity が 'info' を超える signal 数。
 */
export function summarizeAnalysisForAssurance(report: {
  reviewPriority: number;
  signals: ReadonlyArray<{ severity: 'info' | 'notice' | 'review' }>;
}): NonNullable<AssuranceInput['analysis']> {
  return {
    reviewPriority: report.reviewPriority,
    notableSignals: report.signals.filter((s) => s.severity !== 'info').length,
  };
}
