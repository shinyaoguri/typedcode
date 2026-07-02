/**
 * Verification logic for CLI
 * Uses shared verification utilities from @typedcode/shared
 */

import {
  verifyProofFile,
  runAnalysis,
  verifyExamBinding,
  deriveAssurance,
  summarizeAnalysisForAssurance,
  summarizeProcess,
  EXAM_AUTHORITY_KEYS,
  type ProofFile,
  type VerificationProgressCallback,
  type VerificationMode,
  type FullVerificationResult,
  type Analyzer,
  type AnalysisReport,
  type AssuranceResult,
  type ProcessSummary,
  type ExamPackageManifest,
  type ExamBindingVerificationResult,
  type ScreenshotVerificationSummary,
} from '@typedcode/shared';
import { ProgressBar } from './progress.js';

// Re-export ProofFile for use in other modules
export type { ProofFile };

/**
 * 試験モード (ADR-0006) の grader 結果。
 * - rootBindingValid: proof 自己完結の exam root 束縛 (verifyProofFile の rootValid)。package 不要。
 * - binding: `.tcexam` が渡されたときのみ。署名 → packageHash → root → 内容ハッシュ → time-box。
 */
export interface CLIExamResult {
  present: boolean;
  examId: string;
  problemId: string;
  variant: string | null;
  packageProvided: boolean;
  rootBindingValid: boolean;
  binding?: ExamBindingVerificationResult;
}

export interface CLIVerificationResult {
  valid: boolean;
  metadataValid: boolean;
  chainValid: boolean;
  isPureTyping: boolean;
  eventCount: number;
  duration: number;
  pasteEvents: number;
  dropEvents: number;
  poswIterations?: number;
  errorAt?: number;
  errorMessage?: string;
  language: string;
  mode: VerificationMode;
  poswSkipped: boolean;
  signedCheckpoints: FullVerificationResult['signedCheckpoints'];
  /** root がサーバアンカーされているか (ADR-0017) */
  rootAnchored: boolean;
  /** 分析層 (ADR-0009) の advisory レポート。判定ではない。 */
  analysis: AnalysisReport;
  /** 三層保証語彙 (ADR-0020)。実証拠から機械導出した表示用語彙 (valid の置換ではない)。 */
  assurance: AssuranceResult;
  /** プロセス要約 (Phase 8 W3)。制作過程の中立な記述。 */
  processSummary: ProcessSummary;
  /** 試験モードの束縛検証 (ADR-0006)。exam proof でないときは undefined。 */
  exam?: CLIExamResult;
  /**
   * スクリーンショット検証 (#147)。ZIP 入力で計算されたときのみ。undefined = 未検査
   * (JSON 単体入力など)。判定は shared の summarizeScreenshotArtifacts (verify web と同一実装)。
   */
  screenshots?: ScreenshotVerificationSummary;
}

export interface VerifyProofOptions {
  mode?: VerificationMode;
  /** `.tcexam` 問題パッケージ (任意)。あれば署名/復号/内容まで完全検証する。 */
  examPackageManifest?: ExamPackageManifest;
  /** Moodle 提出時刻 (epoch ms, 任意)。time-box の withinWindow 判定に使う。 */
  submittedAtMs?: number;
  /** anchoring 密度 gate (ADR-0016)。true で密度が疎な proof を fail させる (採点 opt-in)。 */
  requireAnchorDensity?: boolean;
  /** root アンカー必須 (ADR-0017)。true で root 未アンカー (serverNonce トークン無し) を fail させる (採点 opt-in)。 */
  requireRootAnchor?: boolean;
  /**
   * 分析に使う Analyzer 群 (ADR-0009 / プラットフォーム方針)。未指定なら shared の
   * `defaultAnalyzers`。採点者/研究者の外部アナライザを CLI が読み込んで差し込むための口。
   * advisory のまま — valid / exit code には一切影響しない (直交性維持)。
   */
  analyzers?: readonly Analyzer[];
  /**
   * ZIP 全体のスクリーンショット検証サマリ (#147)。呼び出し側 (cli.ts) が ZIP から
   * 一度だけ計算して全 proof に渡す (スクショはセッション単位で proof 横断のため)。
   * tampered > 0 は verify (web) の error 軸と同じく valid を落とす。未指定 = 未検査。
   */
  screenshotSummary?: ScreenshotVerificationSummary;
}

export async function verifyProof(
  proof: ProofFile,
  options: VerifyProofOptions = {}
): Promise<CLIVerificationResult> {
  const mode: VerificationMode = options.mode ?? 'full';
  const startTime = performance.now();
  const events = proof.proof.events;
  const eventCount = events.length;

  // Setup progress bar
  console.log('');
  const progressBar = new ProgressBar(eventCount, 'Verifying');

  const onProgress: VerificationProgressCallback = (current) => {
    progressBar.update(current);
  };

  // Run verification using shared utilities
  const result = await verifyProofFile(proof, onProgress, {
    mode,
    requireAnchorDensity: options.requireAnchorDensity,
    requireRootAnchor: options.requireRootAnchor,
  });

  progressBar.complete();

  // 分析層 (ADR-0009): 検証と直交する post-hoc 分析。既定の分析器は方向性を示す
  // プレースホルダのみ。advisory であって判定ではない (verifyProofFile の valid とは別軸)。
  // options.analyzers が渡れば (採点者/研究者の外部アナライザ) それを使う。未指定なら shared 既定。
  const analysis = await runAnalysis({ proof, verification: result }, options.analyzers);

  // 試験モード (ADR-0006): exam ブロックがあれば束縛を検証する。
  // root 束縛は proof 自己完結 (verifyProofFile が rootValid で既に検証済み)。
  // package が渡されたときのみ署名/復号/内容まで完全検証する。
  let exam: CLIExamResult | undefined;
  if (proof.exam) {
    const binding = options.examPackageManifest
      ? await verifyExamBinding(proof, options.examPackageManifest, {
          examAuthorityRegistry: EXAM_AUTHORITY_KEYS,
          submissionTimeMs: options.submittedAtMs,
        })
      : undefined;
    exam = {
      present: true,
      examId: proof.exam.examId,
      problemId: proof.exam.problemId,
      variant: proof.exam.variant,
      packageProvided: !!options.examPackageManifest,
      rootBindingValid: result.rootValid ?? false,
      binding,
    };
  }

  // Calculate statistics
  const pasteEvents = events.filter((e) => e.inputType === 'insertFromPaste').length;
  const dropEvents = events.filter((e) => e.inputType === 'insertFromDrop').length;

  const firstPoswEvent = events.find((e) => e.posw);
  const poswIterations = firstPoswEvent?.posw?.iterations;

  const duration = (performance.now() - startTime) / 1000;

  // package が渡されたとき、束縛失敗は全体を fail にする (proof 自己整合とは別軸の真正性)。
  const examValid = exam?.binding ? exam.binding.valid : true;

  // #147: スクショ改ざんは verify (web) の error 軸 (TrustCalculator/integrity failed) と同じく
  // 全体 fail = exit 1 に合流させる。欠損/chainOnly は warning (web と同じ) で exit 非干渉。
  const screenshotsValid = (options.screenshotSummary?.tampered ?? 0) === 0;

  // 三層保証語彙 (ADR-0020): 実証拠のみから導出 (自己申告 mode は使わない)。
  const assurance = deriveAssurance({
    metadataValid: result.metadataValid,
    chainValid: result.chainValid,
    exam: exam
      ? {
          present: true,
          packageProvided: exam.packageProvided,
          bindingValid: exam.binding?.valid,
        }
      : undefined,
    rootAnchored: result.rootAnchored ?? false,
    signedCheckpoints: result.signedCheckpoints
      ? {
          anchored: result.signedCheckpoints.anchored,
          valid: result.signedCheckpoints.valid,
          sparse: result.signedCheckpoints.density?.sparse,
          postHocSuspected: result.signedCheckpoints.temporal?.postHocSuspected,
        }
      : undefined,
    isPureTyping: result.isPureTyping,
    analysis: summarizeAnalysisForAssurance(analysis),
    // #147: ZIP 入力で検査したときのみ渡す (undefined = 未検査は integrity に影響しない)。
    screenshotsTampered: options.screenshotSummary?.tampered,
  });

  return {
    valid: result.valid && examValid && screenshotsValid,
    metadataValid: result.metadataValid,
    chainValid: result.chainValid,
    isPureTyping: result.isPureTyping,
    eventCount,
    duration,
    pasteEvents,
    dropEvents,
    poswIterations,
    errorAt: result.errorAt,
    errorMessage: result.errorMessage,
    language: proof.language,
    mode,
    poswSkipped: result.poswSkipped ?? false,
    signedCheckpoints: result.signedCheckpoints,
    rootAnchored: result.rootAnchored ?? false,
    analysis,
    assurance,
    processSummary: summarizeProcess(events),
    exam,
    screenshots: options.screenshotSummary,
  };
}
