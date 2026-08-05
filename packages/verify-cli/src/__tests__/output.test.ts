/**
 * CLI 出力の overclaim 抑止 (#214)。
 *
 * `--mode fast` は PoSW の反復再計算をスキップする (spec §8.2)。それでもヘッダが
 * `✓ Verification PASSED` / `Integrity: PROVEN` のままだと、採点者は「10,000 回の逐次作業まで
 * 検証済み」と読む。**主張する保証と実際に提供する保証を一致させる**のがこのテストの守備範囲。
 */

import { describe, expect, it } from 'vitest';
import type { AssuranceResult } from '@typedcode/shared';
import { formatResult, type VerificationOutput } from '../output.js';

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
