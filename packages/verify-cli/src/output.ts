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

import type { VerificationMode, SignedCheckpointsVerificationResult } from '@typedcode/shared';

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
    if (result.errorMessage) {
      lines.push(c('red', `  Error: ${result.errorMessage}`));
    }
    if (result.errorAt !== undefined) {
      lines.push(c('red', `  Failed at event: ${result.errorAt}`));
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
      if (sc.details.some((d) => d.warning === 'key-revoked-but-trusted-by-time')) {
        lines.push(c('yellow', '  ! Some envelopes signed with a key that was later revoked'));
      }
    } else {
      lines.push(`Anchoring:   ${c('red', 'FAILED')} ${sc.reason ?? ''}`);
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

${c('cyan', 'Arguments:')}
  file    Path to proof file (.json) or exported archive (.zip)

${c('cyan', 'Options:')}
  --mode  Verification mode (default: full)
          fast  - Skip PoSW recompute (tamper resistance only)
          audit - fast + deterministic PoSW sampling (placeholder)
          full  - Full PoSW verification

${c('cyan', 'Examples:')}
  typedcode-verify proof.json
  typedcode-verify my-code.zip --mode fast

${c('cyan', 'Exit codes:')}
  0 - Verification passed
  1 - Verification failed or error
`);
}
