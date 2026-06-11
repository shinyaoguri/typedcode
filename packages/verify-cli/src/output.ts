/**
 * Result formatting and terminal output
 */

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
} as const;

const useColors = process.stdout.isTTY && !process.env['NO_COLOR'];

function c(color: keyof typeof COLORS, text: string): string {
  return useColors ? `${COLORS[color]}${text}${COLORS.reset}` : text;
}

import type {
  VerificationMode,
  SignedCheckpointsVerificationResult,
  AnalysisReport,
} from '@typedcode/shared';
import type { CLIExamResult } from './verify.js';

export interface VerificationOutput {
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
  language?: string;
  mode?: VerificationMode;
  poswSkipped?: boolean;
  signedCheckpoints?: SignedCheckpointsVerificationResult;
  /** 分析層 (ADR-0009) の advisory レポート。判定ではない。 */
  analysis?: AnalysisReport;
  /** 試験モードの束縛検証 (ADR-0006)。exam proof でないときは undefined。 */
  exam?: CLIExamResult;
}

function passFail(ok: boolean): string {
  return ok ? c('green', 'PASS') : c('red', 'FAIL');
}

/** 試験モード (ADR-0006) の束縛検証セクションを描画する。 */
function formatExamSection(exam: CLIExamResult, lines: string[]): void {
  lines.push('');
  lines.push(c('cyan', '--- Exam binding (ADR-0006) ---'));
  const variant = exam.variant ? ` / ${exam.variant}` : '';
  lines.push(`Exam:         ${exam.examId} / ${exam.problemId}${variant}`);
  // root 束縛は proof 自己完結 (package 不要)。
  lines.push(`Root binding: ${passFail(exam.rootBindingValid)}  ${c('dim', '(answer bound to package + T0)')}`);

  const b = exam.binding;
  if (!b) {
    lines.push(
      c('yellow', '  ! Package not provided — signature/content checks skipped')
    );
    lines.push(c('dim', '    Pass --exam-package <file.tcexam> to fully verify authenticity.'));
    return;
  }

  lines.push(`Signature:    ${passFail(b.packageSignatureValid)}`);
  lines.push(`Package hash: ${passFail(b.packageHashMatches)}`);
  lines.push(`Content hash: ${passFail(b.problemContentHashMatches)}`);
  if (b.timeBox) {
    const tb = b.timeBox;
    lines.push(`Time-box:     ${tb.releaseTime} … ${tb.deadline}`);
    if (tb.withinWindow === null) {
      lines.push(c('dim', '    (submission time not provided — pass --submitted-at to check the window)'));
    } else {
      lines.push(`  Submitted within window: ${passFail(tb.withinWindow)}`);
    }
  }
  if (!b.valid && b.reason) {
    lines.push(c('red', `  Reason: ${b.reason}`));
  }
}

export function formatResult(result: VerificationOutput): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(c('bold', '=== TypedCode Proof Verification ==='));
  lines.push('');

  if (result.valid) {
    lines.push(c('green', '\u2713 Verification PASSED'));
  } else {
    lines.push(c('red', '\u2717 Verification FAILED'));
    // proof \u81ea\u4f53\u306f\u5065\u5168\u3067 exam \u675f\u7e1b\u3060\u3051\u304c\u5931\u6557\u3057\u305f\u3068\u304d\u3001\u30c1\u30a7\u30fc\u30f3\u306e (\u6210\u529f) \u30e1\u30c3\u30bb\u30fc\u30b8\u3092
    // \u300cError:\u300d\u3068\u3057\u3066\u51fa\u3059\u3068\u8aa4\u89e3\u3092\u62db\u304f\u3002\u305d\u306e\u5834\u5408\u306f exam \u675f\u7e1b\u306e\u7406\u7531\u3092\u51fa\u3059\u3002
    const examBindingFailedOnly =
      result.metadataValid &&
      result.chainValid &&
      !!result.exam?.binding &&
      !result.exam.binding.valid;
    if (examBindingFailedOnly) {
      lines.push(
        c('red', `  Exam binding failed: ${result.exam!.binding!.reason ?? 'see section below'}`)
      );
    } else {
      if (result.errorMessage) {
        lines.push(c('red', `  Error: ${result.errorMessage}`));
      }
      if (result.errorAt !== undefined) {
        lines.push(c('red', `  Failed at event: ${result.errorAt}`));
      }
    }
  }
  lines.push('');

  lines.push(c('cyan', '--- Details ---'));
  if (result.language) {
    lines.push(`Language:        ${result.language}`);
  }
  lines.push(`Total Events:    ${result.eventCount.toLocaleString()}`);
  lines.push(`Verify Duration: ${result.duration.toFixed(1)}s`);
  lines.push('');

  lines.push(c('cyan', '--- Checks ---'));
  lines.push(`Metadata:    ${result.metadataValid ? c('green', 'PASS') : c('red', 'FAIL')}`);
  lines.push(`Hash Chain:  ${result.chainValid ? c('green', 'PASS') : c('red', 'FAIL')}`);

  if (result.isPureTyping) {
    lines.push(`Pure Typing: ${c('green', 'YES')} (no paste/drop detected)`);
  } else {
    lines.push(`Pure Typing: ${c('yellow', 'NO')}`);
    if (result.pasteEvents > 0) {
      lines.push(`  - Paste events: ${result.pasteEvents}`);
    }
    if (result.dropEvents > 0) {
      lines.push(`  - Drop events: ${result.dropEvents}`);
    }
  }

  if (result.poswIterations) {
    const poswStatus = result.poswSkipped ? c('yellow', 'SKIPPED (fast mode)') : c('green', 'VERIFIED');
    lines.push(`PoSW:        ${result.poswIterations.toLocaleString()} iterations/event — ${poswStatus}`);
  }

  if (result.mode) {
    lines.push(`Mode:        ${result.mode}`);
  }

  const sc = result.signedCheckpoints;
  if (sc) {
    if (!sc.anchored) {
      lines.push(`Anchoring:   ${c('yellow', 'unavailable')} (no signed checkpoints)`);
    } else if (sc.valid) {
      const cov = sc.coverage;
      const pct = (cov.coverageRatio * 100).toFixed(1);
      lines.push(`Anchoring:   ${c('green', 'VERIFIED')} (${cov.signedCount} signed checkpoints, ${pct}% coverage)`);
      if (sc.temporal?.postHocSuspected) {
        lines.push(c('yellow', '  ! Post-hoc batch signing suspected (server span << client span)'));
      }
      // anchoring 密度 (ADR-0016): 主張イベント数/時間に対する署名 cp の間隔。
      if (sc.density) {
        const gapServerSec = (sc.density.maxGapServerMs / 1000).toFixed(0);
        lines.push(
          c('dim', `  Density: max gap ${sc.density.maxGapEvents} events / ${gapServerSec}s, first anchor @ event ${sc.density.firstAnchorEventIndex}`)
        );
        if (sc.density.sparse) {
          lines.push(c('yellow', '  ! Anchoring is sparse for the claimed session (few/late signed checkpoints)'));
        }
      }
      if (sc.details.some((d) => d.warning === 'key-revoked-but-trusted-by-time')) {
        lines.push(c('yellow', '  ! Some envelopes signed with a key that was later revoked'));
      }
    } else {
      lines.push(`Anchoring:   ${c('red', 'FAILED')} ${sc.reason ?? ''}`);
    }
  }

  // 試験モード (ADR-0006): exam ブロックがあれば束縛検証セクションを出す。
  if (result.exam) {
    formatExamSection(result.exam, lines);
  }

  // 分析層 (ADR-0009): 検証とは別軸の advisory。判定ではないことを明示する。
  const analysis = result.analysis;
  if (analysis) {
    lines.push('');
    lines.push(c('cyan', '--- Analysis (advisory) ---'));
    lines.push(c('dim', 'Heuristic, not a verdict — for human review only.'));
    if (analysis.signals.length === 0) {
      lines.push('No analysis signals.');
    } else {
      const pct = (analysis.reviewPriority * 100).toFixed(0);
      lines.push(`Review priority: ${pct}%`);
      for (const s of analysis.signals) {
        const tag =
          s.severity === 'review'
            ? c('yellow', 'REVIEW')
            : s.severity === 'notice'
              ? c('yellow', 'NOTICE')
              : c('dim', 'INFO');
        lines.push(`  [${tag}] ${s.dimension}: ${s.summary}`);
      }
    }
  }

  lines.push('');

  return lines.join('\n');
}

export function printError(message: string): void {
  console.error(c('red', `Error: ${message}`));
}

export function printUsage(): void {
  console.log(`
${c('bold', 'typedcode-verify')} - Verify TypedCode proof files

${c('cyan', 'Usage:')}
  typedcode-verify <file.json|file.zip> [--mode <fast|audit|full>]
                   [--exam-package <file.tcexam>] [--submitted-at <ISO>]
                   [--require-anchor-density]

${c('cyan', 'Arguments:')}
  file    Path to proof file (.json) or exported archive (.zip)

${c('cyan', 'Options:')}
  --mode           Verification mode (default: full)
                   fast  - Skip PoSW recompute (tamper resistance only)
                   audit - fast + deterministic PoSW sampling (placeholder)
                   full  - Full PoSW verification
  --exam-package   Exam mode (ADR-0006): sealed problem package (.tcexam) to fully
                   verify the binding (signature, package hash, decrypted content).
                   Without it, only the self-contained exam root binding is checked.
  --submitted-at   Exam mode: submission timestamp (ISO 8601, e.g. Moodle submit time)
                   to evaluate the [releaseTime, deadline] time-box.
  --require-anchor-density
                   Fail (exit 1) when signed checkpoints are too sparse for the claimed
                   session (ADR-0016) — e.g. a single end checkpoint anchoring a long
                   chain. Off by default (sparse anchoring is only a warning).

${c('cyan', 'Examples:')}
  typedcode-verify proof.json
  typedcode-verify my-code.zip --mode fast
  typedcode-verify ALL_TC.zip --exam-package p1.tcexam
  typedcode-verify ALL_TC.zip --exam-package p1.tcexam --submitted-at 2026-06-06T01:00:00Z

${c('cyan', 'Exit codes:')}
  0 - Verification passed
  1 - Verification failed or error
`);
}
