/**
 * CLI 出力の overclaim 抑止 (#214)。
 *
 * `--mode fast` は PoSW の反復再計算をスキップする (spec §8.2)。それでもヘッダが
 * `✓ Verification PASSED` / `Integrity: PROVEN` のままだと、採点者は「10,000 回の逐次作業まで
 * 検証済み」と読む。**主張する保証と実際に提供する保証を一致させる**のがこのテストの守備範囲。
 */

import { describe, expect, it } from 'vitest';
import {
  runAnalysis,
  type AcceptancePolicyResult,
  type AssuranceResult,
  type ScreenshotVerificationSummary,
  type SignedCheckpointsVerificationResult,
  type SubmissionPair,
} from '@typedcode/shared';
import {
  formatMultiSummary,
  formatOrphanSources,
  formatProofHeader,
  formatResult,
  printError,
  printUsage,
  safe,
  type VerificationOutput,
} from '../output.js';
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
function examBindingFailed(): Extract<CLIExamResult, { present: true }> {
  return {
    present: true,
    examId: 'exam-1',
    problemId: 'p1',
    variant: null,
    identifiersVerified: false,
    packageProvided: true,
    rootBindingValid: true,
    binding: {
      valid: false,
      packageSignatureValid: true,
      packageHashMatches: false,
      rootMatches: true,
      problemContentHashMatches: true,
      identifiersMatch: false,
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
    identifiersVerified: true,
    packageProvided: true,
    rootBindingValid: true,
    binding: {
      valid: true,
      packageSignatureValid: true,
      packageHashMatches: true,
      rootMatches: true,
      problemContentHashMatches: true,
      identifiersMatch: true,
      verifiedIds: { examId: 'exam-1', problemId: 'p1', variant: null },
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
      identifiersMatch: false,
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
            totalEvents: 0,
            durationMs: 0,
            contentChangeCount: 0,
            insertedChars: 0,
            deletedChars: 0,
            deletionRatio: null,
            executionCount: 0,
            runSuccessCount: 0,
            runFailureCount: 0,
            hasRunResults: false,
            pauseCount: 0,
            longestPauseMs: null,
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

describe('printError — エラー文言に混じる未信頼文字列の無害化 (#339)', () => {
  /** printError は console.error へ書くので、1 回分を掴む。 */
  function errorOutput(message: string): string {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      printError(message);
    } finally {
      console.error = original;
    }
    return lines.join('\n');
  }

  it('does not emit a raw ESC sequence carried in the message', () => {
    // ZIP エントリ名や proof 由来の文字列は Error.message に埋まって printError へ来る。
    // 端末制御文字がそのまま出ると画面の書き換え (行の偽造) ができてしまう。
    const output = errorOutput(`Failed to read ${FORGED_ENTRY_NAME}`);
    expect(output).not.toContain(`${ESC}[32m`);
    expect(output).not.toContain('\n');
    expect(output).toContain('(sanitized)');
  });

  it('keeps an ordinary message readable with no suffix', () => {
    expect(plain(errorOutput('No proof file given.'))).toBe('Error: No proof file given.');
  });
});

describe('printUsage — --mode の説明が実装と一致する (#283 c2)', () => {
  /** printUsage は console.log へ書くので、1 回分を掴む。 */
  function usageText(): string {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      printUsage();
    } finally {
      console.log = original;
    }
    return plain(lines.join('\n'));
  }

  it('audit を「未実装・現状 full と同等」と説明する', () => {
    // 実装は verify の poswModeFor が audit → 'full' に落としており、spec §6.1 も
    // 「部分的 PoSW 検証 (未実装、現状 full と同等)」。help だけが
    // `fast + deterministic PoSW sampling` = fast 相当と読める文言だった。
    // 採点者が「audit なら軽くて十分」と誤読すると、実際にはフルコストを払う。
    expect(usageText()).toMatch(/audit\s+- unimplemented; currently equivalent to full/);
  });

  it('audit が fast 相当・サンプリング実施だと読める文言を含まない', () => {
    const text = usageText();
    expect(text).not.toMatch(/audit\s+- fast/);
    expect(text).not.toMatch(/deterministic PoSW sampling/);
  });
});

describe('formatResult — proof format version (#223)', () => {
  const VERSION_ERROR = 'Proof version 0.1.0 is older than the minimum supported version 1.0.0';

  it('prints a newer-major warning right under the PASSED header and keeps the verdict', () => {
    const text = plain(formatResult(output({ versionStatus: 'newer', declaredVersion: '2.0.0' })));

    const header = text.slice(text.indexOf('Verification PASSED'), text.indexOf('--- Assurance'));
    expect(header).toContain('proof format version 2.0.0 is newer than this verifier supports');
  });

  it('prints no version warning for current / supported proofs', () => {
    for (const versionStatus of ['current', 'supported'] as const) {
      expect(plain(formatResult(output({ versionStatus })))).not.toContain('newer than this verifier');
    }
  });

  it('prints a rejected version as the failure reason even when an exam binding failure is the only other reason', () => {
    const text = plain(
      formatResult(
        output({
          valid: false,
          versionStatus: 'tooOld',
          errorMessage: VERSION_ERROR,
          exam: examBindingFailed(),
        })
      )
    );

    const header = failureHeader(text);
    expect(header).toContain(`Error: ${VERSION_ERROR}`);
    expect(header).toContain('Exam binding failed: packageHash mismatch');
  });

  it('does not print the version error line twice when nothing else failed', () => {
    const text = plain(formatResult(output({ valid: false, versionStatus: 'tooOld', errorMessage: VERSION_ERROR })));

    expect(text.split(VERSION_ERROR).length - 1).toBe(1);
  });
});

describe('formatResult — Submission section (#293)', () => {
  const pair = (overrides: Partial<SubmissionPair>): SubmissionPair => ({
    proofPath: 'valid_proof.json',
    status: 'match',
    expectedSource: 'valid.js',
    ...overrides,
  });

  it('says a lone JSON input was not checked', () => {
    expect(plain(formatResult(output()))).toMatch(/^Submission: not checked/m);
  });

  it('shows MATCH for an identical source without any failure line', () => {
    const text = plain(formatResult(output({ submission: { pair: pair({}), severity: 'ok' } })));

    expect(text).toMatch(/^--- Submission ---$/m);
    expect(text).toMatch(/^Source:\s+valid\.js\s+MATCH/m);
    expect(text).not.toContain('Submission failed');
  });

  it('shows MISMATCH with sizes and the first difference, and a failure line under FAILED', () => {
    const text = plain(
      formatResult(
        output({
          valid: false,
          submission: {
            pair: pair({
              status: 'mismatch',
              mismatch: { proofContentBytes: 1, sourceBytes: 32, firstDifferenceOffset: 0 },
            }),
            severity: 'failure',
          },
        })
      )
    );

    expect(text).toContain('Verification FAILED');
    expect(text).toContain('Submission failed: bundled source differs from the verified proof content (valid.js)');
    expect(text).toMatch(/^Source:\s+valid\.js\s+MISMATCH/m);
    expect(text).toContain('source 32 bytes, proof.content 1 bytes, first difference at byte 0');
    // 提出物の不整合を、チェーンの成功メッセージの `Error:` として出さない
    expect(text).not.toMatch(/^\s*Error:/m);
  });

  it('still prints the chain error when the chain itself failed next to a submission failure', () => {
    const text = plain(
      formatResult(
        output({
          valid: false,
          chainValid: false,
          errorMessage: 'Previous hash mismatch',
          submission: { pair: pair({ status: 'ambiguous', reason: 'cannot pair' }), severity: 'failure' },
        })
      )
    );

    expect(text).toContain('Error: Previous hash mismatch');
    expect(text).toContain('Submission failed: cannot determine which source file belongs to this proof');
  });

  it('shows MISSING as a warning that does not fail the run', () => {
    const text = plain(
      formatResult(output({ submission: { pair: pair({ status: 'missing-source' }), severity: 'warning' } }))
    );

    expect(text).toContain('Verification PASSED');
    expect(text).toMatch(/^Source:\s+MISSING \(expected valid\.js/m);
  });

  it('shows AMBIGUOUS and UNCHECKABLE with their reasons', () => {
    const ambiguous = plain(
      formatResult(
        output({
          valid: false,
          submission: {
            pair: pair({ status: 'ambiguous', reason: 'more than one proof expects it' }),
            severity: 'failure',
          },
        })
      )
    );
    const uncheckable = plain(
      formatResult(
        output({
          valid: false,
          submission: {
            pair: { proofPath: 'a_proof.json', status: 'uncheckable', reason: 'proof has no filename or content' },
            severity: 'failure',
          },
        })
      )
    );

    expect(ambiguous).toMatch(/^Source:\s+AMBIGUOUS \(valid\.js: more than one proof expects it\)/m);
    expect(uncheckable).toMatch(/^Source:\s+UNCHECKABLE \(proof has no filename or content\)/m);
    expect(uncheckable).toContain('Submission failed: proof has no filename/content');
  });

  it('does not let a source name from the ZIP forge a line or colour (safe())', () => {
    const text = plain(
      formatResult(
        output({
          valid: false,
          submission: {
            pair: pair({
              status: 'mismatch',
              expectedSource: 'x\u001b[32m\n✓ forged_proof.json',
              mismatch: { proofContentBytes: 1, sourceBytes: 2, firstDifferenceOffset: 0 },
            }),
            severity: 'failure',
          },
        })
      )
    );

    expect(text).not.toMatch(/^✓ forged_proof\.json/m);
    expect(text).toContain('(sanitized)');
  });
});

describe('formatOrphanSources (#293)', () => {
  it('lists every orphan as a warning line, with the name sanitized', () => {
    const text = plain(formatOrphanSources(['extra.py', 'y\n✓ forged.c']));

    expect(text).toContain('! Source file not matched to any proof: extra.py');
    expect(text.split('\n').filter((l) => l.startsWith('✓'))).toEqual([]);
  });
});

describe('formatResult — テンプレート注入量の advisory (#416)', () => {
  it('prints the template and typed character counts as an INFO line in the advisory section', async () => {
    const events = [
      { type: 'templateInjection', timestamp: 0, data: { content: 'x'.repeat(500), contentLength: 0 } },
      { type: 'contentChange', timestamp: 1000, data: 'y'.repeat(10), inputType: 'insertText' },
    ];
    const analysis = await runAnalysis({
      proof: { proof: { events } } as never,
      verification: { valid: true, metadataValid: true, chainValid: true, isPureTyping: true } as never,
    });

    const text = plain(formatResult(output({ analysis })));

    const section = text.slice(text.indexOf('--- Analysis (advisory) ---'));
    const line = section.split('\n').find((l) => l.includes('Template-injected content'));
    expect(line).toBe(
      '  [INFO] transcription-topology: Template-injected content: 500 chars from templates, 10 chars typed'
    );
  });
});

describe('formatResult — 分析できなかった分析器 (#301)', () => {
  function analysisSection(text: string): string {
    return text.slice(text.indexOf('--- Analysis (advisory) ---'));
  }

  it('names every analyzer that failed or timed out on one Analysis unavailable line', () => {
    const text = plain(
      formatResult(
        output({
          analysis: {
            analyzerVersions: { boom: '1', hang: '1' },
            analyzerStatus: {
              boom: { version: '1', status: 'failed', message: 'analyzer failure' },
              hang: { version: '1', status: 'timeout', message: 'did not settle within 10000 ms' },
            },
            signals: [],
            reviewPriority: 0,
          },
        })
      )
    );

    expect(analysisSection(text)).toContain('Analysis unavailable: boom (failed), hang (timeout)');
  });

  it('does not claim No analysis signals when every analyzer failed', () => {
    const text = plain(
      formatResult(
        output({
          analysis: {
            analyzerVersions: { boom: '1' },
            analyzerStatus: { boom: { version: '1', status: 'failed', message: 'analyzer failure' } },
            signals: [],
            reviewPriority: 0,
          },
        })
      )
    );

    expect(analysisSection(text)).not.toContain('No analysis signals.');
  });

  it('prints No analysis signals when every analyzer finished ok with nothing to report', () => {
    const text = plain(
      formatResult(
        output({
          analysis: {
            analyzerVersions: { quiet: '1' },
            analyzerStatus: { quiet: { version: '1', status: 'ok' } },
            signals: [],
            reviewPriority: 0,
          },
        })
      )
    );

    expect(analysisSection(text)).toContain('No analysis signals.');
    expect(analysisSection(text)).not.toContain('Analysis unavailable');
  });

  it('keeps the failure message of an external analyzer on one sanitized line', () => {
    const text = plain(
      formatResult(
        output({
          analysis: {
            analyzerVersions: { boom: '1' },
            analyzerStatus: { boom: { version: '1', status: 'failed', message: 'x\n✓ Verification PASSED' } },
            signals: [],
            reviewPriority: 0,
          },
        })
      )
    );

    expect(text.split('\n').filter((l) => l.startsWith('✓ Verification PASSED'))).toHaveLength(1);
    expect(analysisSection(text)).toContain('boom: x✓ Verification PASSED (sanitized)');
  });
});

/**
 * 未署名の末尾 (#295): 最後の署名 cp より後のイベントはサーバ時刻の上界を持たない。Timeline が
 * ANCHORED にならない理由を、Anchoring 行の最終署名位置と警告行で読めるようにする。
 */
describe('formatResult — 未署名の末尾 (#295)', () => {
  function signedCheckpoints(
    coverage: Partial<SignedCheckpointsVerificationResult['coverage']>
  ): SignedCheckpointsVerificationResult {
    return {
      valid: true,
      anchored: true,
      details: [],
      coverage: {
        signedCount: 1,
        lastSignedEventIndex: 0,
        coverageRatio: 1 / 3,
        unsignedTailEvents: 2,
        terminalAnchored: false,
        ...coverage,
      },
      temporal: null,
      density: null,
    };
  }

  it('shows the position of the last signed event on the Anchoring line', () => {
    const text = plain(formatResult(output({ signedCheckpoints: signedCheckpoints({}) })));

    expect(text).toMatch(/^Anchoring: +VERIFIED \(1 signed checkpoints, 33\.3% coverage, last signed event #0\)$/m);
  });

  it('warns with the count of trailing events not covered by a signed checkpoint', () => {
    const text = plain(formatResult(output({ signedCheckpoints: signedCheckpoints({}) })));

    expect(text).toContain('  ! 2 trailing events are not covered by a signed checkpoint (unsigned tail)');
  });

  it('does not warn about an unsigned tail when the last signed checkpoint is the final event', () => {
    const text = plain(
      formatResult(
        output({
          signedCheckpoints: signedCheckpoints({
            signedCount: 3,
            lastSignedEventIndex: 2,
            coverageRatio: 1,
            unsignedTailEvents: 0,
            terminalAnchored: true,
          }),
        })
      )
    );

    expect(text).toContain('last signed event #2');
    expect(text).not.toContain('unsigned tail');
  });
});

describe('formatResult — acceptance policy (#296)', () => {
  const NONE = {
    requireRootAnchor: false,
    requireAnchorDensity: false,
    requireSignedCheckpoints: false,
    requireTerminalAnchor: false,
  };

  function policy(overrides: Partial<AcceptancePolicyResult> = {}): AcceptancePolicyResult {
    return {
      applied: { ...NONE, requireSignedCheckpoints: true, requireTerminalAnchor: true },
      evaluated: true,
      violations: [],
      ...overrides,
    };
  }

  it('prints nothing about the policy when no requirement is applied, byte for byte', () => {
    const without = formatResult(output());
    const withEmptyPolicy = formatResult(output({ policy: { applied: NONE, evaluated: true, violations: [] } }));

    expect(withEmptyPolicy).toBe(without);
    expect(plain(without)).not.toContain('Acceptance policy');
  });

  it('lists the applied requirements by their CLI flags', () => {
    const text = plain(formatResult(output({ policy: policy() })));

    expect(text).toContain('--- Acceptance policy ---');
    expect(text).toMatch(/^Applied: +--require-signed-checkpoints, --require-final-anchor$/m);
  });

  it('says all requirements are met when there is no violation', () => {
    const text = plain(formatResult(output({ policy: policy() })));

    expect(text).toMatch(/^Result: +all requirements met$/m);
    expect(text).not.toContain('FAIL signed-checkpoints-missing');
  });

  it('prints one FAIL line per violation with its code, and the unsigned tail count for the final anchor', () => {
    const text = plain(
      formatResult(
        output({
          valid: false,
          errorMessage: 'Signed checkpoints are required but the proof has none',
          policy: policy({
            violations: [
              { code: 'signed-checkpoints-missing', message: 'Signed checkpoints are required but the proof has none' },
              {
                code: 'terminal-anchor-missing',
                message:
                  'A signed checkpoint on the final event is required but the last events are not covered by one',
                unsignedTailEvents: 3,
              },
            ],
          }),
        })
      )
    );

    expect(text).toMatch(/^Result: +2 requirement\(s\) not met$/m);
    expect(text).toContain('  FAIL signed-checkpoints-missing: Signed checkpoints are required but the proof has none');
    expect(text).toMatch(/^ {2}FAIL terminal-anchor-missing: .+ \(3 unsigned trailing events\)$/m);
  });

  it('says the policy was not evaluated when verification itself failed', () => {
    const text = plain(formatResult(output({ valid: false, chainValid: false, policy: policy({ evaluated: false }) })));

    expect(text).toMatch(/^Result: +not evaluated \(verification failed\)$/m);
    expect(text).not.toContain('FAIL signed-checkpoints-missing');
  });

  it('places the policy section after the checks, apart from them', () => {
    const text = plain(formatResult(output({ policy: policy() })));

    expect(text.indexOf('Submission: not checked')).toBeGreaterThan(text.indexOf('--- Checks ---'));
    expect(text.indexOf('--- Acceptance policy ---')).toBeGreaterThan(text.indexOf('Submission: not checked'));
  });

  it('keeps a violation entry on one line even if it carries control characters', () => {
    const forged = policy({
      violations: [{ code: 'signed-checkpoints-missing', message: 'x\nHash Chain:  PASS' }],
    });
    const text = plain(formatResult(output({ valid: false, policy: forged })));

    // 本物の Checks の 1 行だけが行頭に立ち、注入した行は FAIL 行の中に収まる。
    expect(text.match(/^Hash Chain: {2}PASS$/gm)).toHaveLength(1);
    expect(text).toContain('  FAIL signed-checkpoints-missing: xHash Chain:  PASS (sanitized)');
  });
});

describe('printUsage — acceptance policy flags (#296)', () => {
  function usageText(): string {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      printUsage();
    } finally {
      console.log = original;
    }
    return plain(lines.join('\n'));
  }

  it.each(['--require-signed-checkpoints', '--require-final-anchor'])('documents %s', (flag) => {
    expect(usageText()).toMatch(new RegExp(`^  ${flag}$`, 'm'));
  });
});

describe('formatResult — 封印 starter の照合 (#718)', () => {
  function examWithStarter(
    starter: NonNullable<NonNullable<Extract<CLIExamResult, { present: true }>['binding']>['starter']>
  ): CLIExamResult {
    const base = examBindingLate() as Extract<CLIExamResult, { present: true }>;
    const valid = starter.status !== 'mismatch';
    return {
      ...base,
      binding: {
        ...base.binding!,
        valid,
        starter,
        ...(valid ? {} : { reason: starter.reason }),
      },
    };
  }

  function starterLine(text: string): string | undefined {
    return text.split('\n').find((line) => line.startsWith('Starter:'));
  }

  it('prints PASS on the Starter line when the injections match the sealed starter', () => {
    const text = plain(formatResult(output({ exam: examWithStarter({ status: 'matched' }) })));
    expect(starterLine(text)).toContain('PASS');
  });

  it('prints FAIL on the Starter line and the starter reason when an injection differs', () => {
    const reason = 'Template injection at event 2 does not match the sealed starter';
    const text = plain(
      formatResult(output({ valid: false, exam: examWithStarter({ status: 'mismatch', reason, eventIndex: 2 }) }))
    );
    expect(starterLine(text)).toContain('FAIL');
    expect(text).toContain(`Reason: ${reason}`);
  });

  it('prints NOT EVALUATED rather than PASS or FAIL for a legacy package', () => {
    const text = plain(formatResult(output({ exam: examWithStarter({ status: 'not-evaluated', reason: 'legacy' }) })));
    const line = starterLine(text) ?? '';
    expect(line).toContain('NOT EVALUATED');
    expect(line).not.toMatch(/PASS|FAIL/);
  });

  it('omits the Starter line when the binding result carries no starter check', () => {
    const text = plain(formatResult(output({ exam: examBindingFailed() })));
    expect(starterLine(text)).toBeUndefined();
  });
});
