/**
 * Verification logic for CLI
 * Uses shared verification utilities from @typedcode/shared
 */

import {
  verifyProofFile,
  runAnalysis,
  verifyExamBinding,
  EXAM_AUTHORITY_KEYS,
  type ProofFile,
  type VerificationProgressCallback,
  type VerificationMode,
  type FullVerificationResult,
  type AnalysisReport,
  type ExamPackageManifest,
  type ExamBindingVerificationResult,
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
  /** 試験モードの束縛検証 (ADR-0006)。exam proof でないときは undefined。 */
  exam?: CLIExamResult;
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
  const analysis = await runAnalysis({ proof, verification: result });

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

  return {
    valid: result.valid && examValid,
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
    exam,
  };
}
