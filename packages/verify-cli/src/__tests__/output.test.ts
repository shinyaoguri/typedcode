/**
 * CLI 出力の overclaim 抑止 (#214)。
 *
 * `--mode fast` は PoSW の反復再計算をスキップする (spec §8.2)。それでもヘッダが
 * `✓ Verification PASSED` / `Integrity: PROVEN` のままだと、採点者は「10,000 回の逐次作業まで
 * 検証済み」と読む。**主張する保証と実際に提供する保証を一致させる**のがこのテストの守備範囲。
 */

import { describe, expect, it } from 'vitest';
import type { AssuranceResult, ScreenshotVerificationSummary } from '@typedcode/shared';
import { formatMultiSummary, formatProofHeader, formatResult, safe, type VerificationOutput } from '../output.js';
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

/** 束縛は全て通っているが提出が窓の外だった proof (time-box は advisory / ADR-0013)。 */
function examBindingLate(): CLIExamResult {
  return {
    present: true,
    examId: 'exam-1',
    problemId: 'p1',
    variant: null,
    packageProvided: true,
    rootBindingValid: true,
    binding: {
      valid: true,
      packageSignatureValid: true,
      packageHashMatches: true,
      rootMatches: true,
      problemContentHashMatches: true,
      timeBox: {
        releaseTime: '2026-06-06T00:00:00.000Z',
        deadline: '2026-06-06T03:00:00.000Z',
        windowCoherent: true,
        withinWindow: false,
      },
    },
  };
}

/** exam ブロックが無い proof に `--exam-package` を渡したとき (#218: ゲートの誤用)。 */
function examPackageNotApplicable(): CLIExamResult {
  return {
    present: false,
    packageProvided: true,
    rootBindingValid: false,
    binding: {
      valid: false,
      packageSignatureValid: false,
      packageHashMatches: false,
      rootMatches: false,
      problemContentHashMatches: false,
      timeBox: null,
      reason: 'Proof has no exam block',
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

describe('formatResult — exam ブロックの無い proof に package を渡したとき (#218)', () => {
  it('names the missing exam block as the failure reason instead of the chain success message', () => {
    const text = plain(
      formatResult(
        output({
          valid: false,
          errorMessage: CHAIN_SUCCESS_MESSAGE,
          exam: examPackageNotApplicable(),
        })
      )
    );

    const header = failureHeader(text);
    expect(header).toContain('Exam binding failed: Proof has no exam block');
    expect(header).not.toContain(CHAIN_SUCCESS_MESSAGE);
  });

  it('states that the gate does not apply instead of printing empty exam fields', () => {
    const text = plain(
      formatResult(
        output({
          valid: false,
          errorMessage: CHAIN_SUCCESS_MESSAGE,
          exam: examPackageNotApplicable(),
        })
      )
    );

    const section = text.slice(text.indexOf('--- Exam binding'));
    expect(section).toContain('--exam-package was provided but this proof has no exam block');
    expect(section).toContain('Reason: Proof has no exam block');
    // 存在しない値を空欄や undefined で見せない (採点者が「exam proof だ」と読み違える)。
    expect(section).not.toContain('Exam:');
    expect(section).not.toContain('Root binding:');
    expect(section).not.toContain('undefined');
  });
});

describe('formatResult — time-box は advisory (ADR-0013 / #220)', () => {
  it('does not print FAIL on the time-box line of a late submission', () => {
    const text = plain(formatResult(output({ exam: examBindingLate() })));

    const windowLine = text.split('\n').find((line) => line.includes('Submitted within window'));
    expect(windowLine).toBeDefined();
    expect(windowLine).not.toContain('FAIL');
  });

  it('marks a missed submission window as advisory rather than a verification failure', () => {
    const text = plain(formatResult(output({ exam: examBindingLate() })));

    const windowLine = text.split('\n').find((line) => line.includes('Submitted within window')) ?? '';
    expect(windowLine).toMatch(/advisory/i);
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

/**
 * 出力境界のサニタイズ (#266)。
 *
 * proof / ZIP 由来の文字列を生値のまま stdout に流すと、改行と ANSI エスケープで**任意の行を
 * 偽造できる**。実 CLI で「ZIP エントリ名から Summary に緑の `✓ main_proof.json` を生やす」
 * ところまで再現済み。exit code は守られるので、守るのは **stdout を grep する採点運用**。
 */
const ESC = String.fromCharCode(27);

/** Summary の合格行を偽造しにくる ZIP エントリ名。 */
const FORGED_ENTRY_NAME = `evil_proof.json\n  ${ESC}[32m✓${ESC}[0m main_proof.json`;

describe('safe — 未信頼文字列の無害化 (#266)', () => {
  it('leaves an ordinary value untouched (no noisy suffix on the happy path)', () => {
    expect(safe('main_proof.json')).toBe('main_proof.json');
  });

  it('strips control characters and says so', () => {
    const result = safe(FORGED_ENTRY_NAME);
    expect(result).not.toContain('\n');
    expect(result).not.toContain(ESC);
    expect(result).toContain('(sanitized)');
  });

  it('truncates an over-long value and says so', () => {
    const result = safe('a'.repeat(500));
    expect(result).toBe(`${'a'.repeat(200)} (sanitized)`);
  });

  it('accepts non-strings (proof fields are self-asserted, not type-checked)', () => {
    expect(safe(10000)).toBe('10000');
    expect(safe(undefined)).toBe('undefined');
  });
});

describe('formatMultiSummary — ZIP エントリ名による合格行の偽造 (#266)', () => {
  it('keeps one line per proof even when an entry name carries a newline', () => {
    const text = plain(
      formatMultiSummary([
        { filename: FORGED_ENTRY_NAME, valid: false },
        { filename: 'main_proof.json', valid: false },
      ])
    );

    // 見出し 1 行 + proof 2 行。偽造行が混ざれば 4 行になる。
    expect(text.trim().split('\n')).toHaveLength(3);
    expect(text).not.toContain(ESC);
    // 合格印は行頭にしか立たない。名前の中に残る `✓` の文字そのものは無害。
    expect(text.split('\n').filter((l) => /^ {2}✓/.test(l))).toHaveLength(0);
    expect(text).toContain('0/2 proofs passed');
  });

  it('still marks genuinely passing proofs', () => {
    const text = plain(formatMultiSummary([{ filename: 'ok_proof.json', valid: true }]));
    expect(text).toContain('1/1 proofs passed');
    expect(text).toContain(`✓ ok_proof.json`);
  });
});

describe('formatProofHeader — proof ごとの見出し (#266)', () => {
  it('collapses a forged entry name into a single header line', () => {
    const text = plain(formatProofHeader(FORGED_ENTRY_NAME));
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(text).not.toContain(ESC);
    expect(text).toContain('(sanitized)');
  });
});

describe('formatResult — proof 由来の文字列による偽セクションの注入 (#266)', () => {
  it('does not let errorMessage open a second Checks block', () => {
    const text = plain(
      formatResult(
        output({
          valid: false,
          chainValid: false,
          errorMessage: `Hash mismatch\n\n--- Checks ---\nHash Chain:  PASS`,
        })
      )
    );

    // 見出しとして立つ `--- Checks ---` は 1 つだけ。注入分は `Error:` 行の中に留まる。
    const lines = text.split('\n');
    expect(lines.filter((l) => l.trim() === '--- Checks ---')).toHaveLength(1);
    expect(lines.filter((l) => /^Hash Chain: +PASS/.test(l))).toHaveLength(0);
  });

  it('does not emit ANSI escapes carried by a self-asserted examId', () => {
    const text = formatResult(
      output({
        valid: false,
        exam: { ...examBindingFailed(), examId: `exam-1${ESC}[32m` },
      })
    );

    expect(text).not.toContain(`exam-1${ESC}[32m`);
    expect(plain(text)).toContain('(sanitized)');
  });

  it('does not let a reflection note inject a line, but keeps its newlines readable', () => {
    const text = plain(
      formatResult(
        output({
          processSummary: {
            durationMs: 0,
            insertedChars: 0,
            deletedChars: 0,
            deletionRatio: null,
            executionCount: 0,
            runSuccessCount: 0,
            runFailureCount: 0,
            hasRunResults: false,
            pauseCount: 0,
            focusLossCount: 0,
            externalInputCount: 0,
            reflectionNotes: [`first${ESC}[31m\nsecond`],
            moments: [],
          },
        })
      )
    );

    const reflection = text.split('\n').filter((l) => l.startsWith('Reflection:'));
    expect(reflection).toHaveLength(1);
    // 改行は ` / ` へ畳んで読めるまま、ESC だけが落ちる (`[31m` の文字は無害なので残る)。
    expect(reflection[0]).toContain(' / second');
    expect(reflection[0]).not.toContain(ESC);
    expect(reflection[0]).toContain('(sanitized)');
  });
});
