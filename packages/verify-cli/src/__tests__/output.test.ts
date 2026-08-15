/**
 * CLI 出力の overclaim 抑止 (#214)。
 *
 * `--mode fast` は PoSW の反復再計算をスキップする (spec §8.2)。それでもヘッダが
 * `✓ Verification PASSED` / `Integrity: PROVEN` のままだと、採点者は「10,000 回の逐次作業まで
 * 検証済み」と読む。**主張する保証と実際に提供する保証を一致させる**のがこのテストの守備範囲。
 */

import { describe, expect, it } from 'vitest';
import type { AssuranceResult, ScreenshotVerificationSummary } from '@typedcode/shared';
import { formatResult, type VerificationOutput } from '../output.js';
import type { CLIExamResult } from '../verify.js';

/** 色付けは TTY 依存 (module load 時に決まる) なので、比較前に ANSI を落とす。 */
function plain(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI エスケープの除去そのものが目的
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function assurance(overrides: Partial<AssuranceResult> = {}): AssuranceResult {
  return {
    integrity: 'proven',
    temporal: 'anchored',
    provenance: { pureTyping: true, notableSignals: 0, reviewPriority: 0 },
    ...overrides,
  };
}

function output(overrides: Partial<VerificationOutput> = {}): VerificationOutput {
  return {
    valid: true,
    metadataValid: true,
    chainValid: true,
    isPureTyping: true,
    eventCount: 42,
    duration: 0.1,
    pasteEvents: 0,
    dropEvents: 0,
    poswIterations: 10000,
    mode: 'full',
    poswSkipped: false,
    assurance: assurance(),
    ...overrides,
  };
}

function screenshots(overrides: Partial<ScreenshotVerificationSummary> = {}): ScreenshotVerificationSummary {
  return { total: 8, verified: 7, missing: 0, tampered: 1, chainOnly: 0, ...overrides };
}

/** exam 束縛だけが落ちた proof (チェーンは健全)。 */
function examBindingFailed(): CLIExamResult {
  return {
    present: true,
    examId: 'exam-1',
    problemId: 'p1',
    variant: null,
    packageProvided: true,
    rootBindingValid: true,
    binding: {
      valid: false,
      packageSignatureValid: true,
      packageHashMatches: false,
      rootMatches: true,
      problemContentHashMatches: true,
      timeBox: null,
      reason: 'packageHash mismatch',
    },
  };
}

/** チェーン検証が通ったときに shared が返す (成功) メッセージ。 */
const CHAIN_SUCCESS_MESSAGE = 'All hashes verified successfully (including PoSW)';

/** FAILED ヘッダから Assurance セクションまで = 「なぜ落ちたか」を述べる領域。 */
function failureHeader(text: string): string {
  return text.slice(text.indexOf('Verification FAILED'), text.indexOf('--- Assurance'));
}

describe('formatResult — 総合 FAILED の理由表示 (#217)', () => {
  it('reports the chain failure reason when the chain itself is broken', () => {
    const text = plain(
      formatResult(
        output({
          valid: false,
          chainValid: false,
          errorMessage: 'Hash mismatch at event 3',
          errorAt: 3,
          assurance: assurance({ integrity: 'failed' }),
        })
      )
    );

    expect(failureHeader(text)).toContain('Error: Hash mismatch at event 3');
  });

  it('reports the exam binding reason when only the exam binding failed', () => {
    const text = plain(
      formatResult(
        output({
          valid: false,
          errorMessage: CHAIN_SUCCESS_MESSAGE,
          exam: examBindingFailed(),
        })
      )
    );

    expect(failureHeader(text)).toContain('Exam binding failed: packageHash mismatch');
    expect(failureHeader(text)).not.toContain(CHAIN_SUCCESS_MESSAGE);
  });

  it('never presents the chain success message as the error when only screenshots were tampered', () => {
    const text = plain(
      formatResult(
        output({
          valid: false,
          errorMessage: CHAIN_SUCCESS_MESSAGE,
          screenshots: screenshots({ tampered: 1 }),
        })
      )
    );

    expect(failureHeader(text)).not.toContain(CHAIN_SUCCESS_MESSAGE);
  });

  it('names the tampered screenshots as the failure reason when only screenshots were tampered', () => {
    const text = plain(
      formatResult(
        output({
          valid: false,
          errorMessage: CHAIN_SUCCESS_MESSAGE,
          screenshots: screenshots({ tampered: 2, verified: 6 }),
        })
      )
    );

    expect(failureHeader(text)).toContain('Screenshots failed: 2/8 tampered');
  });

  it('reports both reasons when the exam binding and the screenshots failed together', () => {
    const text = plain(
      formatResult(
        output({
          valid: false,
          errorMessage: CHAIN_SUCCESS_MESSAGE,
          exam: examBindingFailed(),
          screenshots: screenshots({ tampered: 1 }),
        })
      )
    );

    const header = failureHeader(text);
    expect(header).toContain('Exam binding failed: packageHash mismatch');
    expect(header).toContain('Screenshots failed: 1/8 tampered');
  });
});

describe('formatResult — PoSW が再計算されなかったとき (fast モード)', () => {
  it('states next to the PASSED header that the PoSW was not recomputed', () => {
    const text = plain(
      formatResult(output({ mode: 'fast', poswSkipped: true, assurance: assurance({ integrity: 'partial' }) }))
    );

    const header = text.slice(text.indexOf('Verification PASSED'), text.indexOf('--- Assurance'));
    expect(header).toMatch(/fast mode/i);
    expect(header).toMatch(/PoSW/);
  });

  it('does not print Integrity: PROVEN when the PoSW was not recomputed', () => {
    const text = plain(
      formatResult(output({ mode: 'fast', poswSkipped: true, assurance: assurance({ integrity: 'partial' }) }))
    );

    expect(text).not.toMatch(/Integrity: +PROVEN/);
    expect(text).toMatch(/Integrity: +PARTIAL/);
  });

  it('keeps printing Integrity: PROVEN when the PoSW was actually recomputed', () => {
    const text = plain(formatResult(output()));

    expect(text).toMatch(/Integrity: +PROVEN/);
    expect(text).not.toMatch(/fast mode/i);
  });

  it('keeps printing Integrity: FAILED when verification actually failed in fast mode', () => {
    const text = plain(
      formatResult(
        output({
          valid: false,
          chainValid: false,
          mode: 'fast',
          poswSkipped: true,
          errorMessage: 'Hash mismatch at event 3',
          assurance: assurance({ integrity: 'failed' }),
        })
      )
    );

    expect(text).toMatch(/Integrity: +FAILED/);
    expect(text).toContain('Verification FAILED');
  });
});
