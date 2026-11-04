import { describe, it, expect, vi } from 'vitest';
import { ANALYZER_TIMEOUT_MS, runAnalysis } from '../analysis/orchestrator.js';
import { pureTypingAnalyzer } from '../analysis/analyzers/pureTypingAnalyzer.js';
import type { AnalysisInput, AnalysisSignal, Analyzer } from '../analysis/types.js';

/** 分析器が触る最小フィールドだけを持つ AnalysisInput を組む (残りは未使用)。 */
function makeInput(opts: {
  isPureTyping?: boolean;
  timestamps?: number[];
  /** paste/drop など禁止 InputType のイベントを混ぜる (pureTypingAnalyzer の証拠源)。 */
  prohibitedInputs?: import('../types/events.js').InputType[];
}): AnalysisInput {
  const events: Array<{ sequence: number; timestamp: number; inputType?: string }> = (opts.timestamps ?? []).map(
    (t, i) => ({ sequence: i, timestamp: t })
  );
  (opts.prohibitedInputs ?? []).forEach((inputType, k) => {
    events.push({ sequence: events.length, timestamp: 1000 + k, inputType });
  });
  return {
    proof: { proof: { events } } as unknown as AnalysisInput['proof'],
    verification: {
      valid: true,
      metadataValid: true,
      chainValid: true,
      isPureTyping: opts.isPureTyping ?? true,
    } as AnalysisInput['verification'],
  };
}

function fixedAnalyzer(id: string, signals: AnalysisSignal[]): Analyzer {
  return { id, version: '1.0.0', analyze: () => signals };
}

function signal(partial: Partial<AnalysisSignal> & { analyzerId: string }): AnalysisSignal {
  return {
    dimension: 'automation',
    score: 1,
    confidence: 1,
    severity: 'review',
    evidence: [],
    summary: 'test',
    ...partial,
  };
}

describe('runAnalysis orchestrator', () => {
  it('aggregates signals from every analyzer', async () => {
    const report = await runAnalysis(makeInput({}), [
      fixedAnalyzer('a', [signal({ analyzerId: 'a' })]),
      fixedAnalyzer('b', [signal({ analyzerId: 'b' })]),
    ]);
    expect(report.signals.map((s) => s.analyzerId)).toEqual(['a', 'b']);
  });

  it('records each analyzer id to its version for provenance', async () => {
    const report = await runAnalysis(makeInput({}), [fixedAnalyzer('a', []), fixedAnalyzer('b', [])]);
    expect(report.analyzerVersions).toEqual({ a: '1.0.0', b: '1.0.0' });
  });

  it('sets reviewPriority to the max severity-weighted contribution', async () => {
    const report = await runAnalysis(makeInput({}), [
      fixedAnalyzer('a', [signal({ analyzerId: 'a', severity: 'review', score: 1, confidence: 1 })]),
    ]);
    expect(report.reviewPriority).toBe(1);
  });

  it('weights a signal contribution by its confidence', async () => {
    const report = await runAnalysis(makeInput({}), [
      fixedAnalyzer('a', [signal({ analyzerId: 'a', severity: 'review', score: 1, confidence: 0.5 })]),
    ]);
    expect(report.reviewPriority).toBe(0.5);
  });

  it('does not let info signals raise reviewPriority', async () => {
    const report = await runAnalysis(makeInput({}), [
      fixedAnalyzer('a', [signal({ analyzerId: 'a', severity: 'info', score: 1, confidence: 1 })]),
    ]);
    expect(report.reviewPriority).toBe(0);
  });

  it('keeps other analyzers when one throws', async () => {
    const throwing: Analyzer = {
      id: 'boom',
      version: '1.0.0',
      analyze: () => {
        throw new Error('analyzer failure');
      },
    };
    const report = await runAnalysis(makeInput({}), [throwing, fixedAnalyzer('ok', [signal({ analyzerId: 'ok' })])]);
    expect(report.signals.map((s) => s.analyzerId)).toEqual(['ok']);
    expect(report.analyzerVersions['boom']).toBe('1.0.0');
  });
});

/** 任意の値を返す分析器 (契約に合わない出力を作るため、型は外す)。 */
function rawAnalyzer(id: string, analyze: () => unknown): Analyzer {
  return { id, version: '1.0.0', analyze: analyze as Analyzer['analyze'] };
}

const throwing = (id: string): Analyzer =>
  rawAnalyzer(id, () => {
    throw new Error('analyzer failure');
  });

describe('runAnalysis analyzer status (#301)', () => {
  it('records an analyzer that returns a valid array as ok', async () => {
    const report = await runAnalysis(makeInput({}), [fixedAnalyzer('quiet', [])]);
    expect(report.analyzerStatus).toEqual({ quiet: { version: '1.0.0', status: 'ok' } });
  });

  it('records a synchronously throwing analyzer as failed with its message', async () => {
    const report = await runAnalysis(makeInput({}), [throwing('boom')]);
    expect(report.analyzerStatus['boom']).toEqual({ version: '1.0.0', status: 'failed', message: 'analyzer failure' });
  });

  it('records an analyzer whose promise rejects as failed', async () => {
    const report = await runAnalysis(makeInput({}), [rawAnalyzer('reject', () => Promise.reject(new Error('later')))]);
    expect(report.analyzerStatus['reject']?.status).toBe('failed');
  });

  it('keeps signals of ok analyzers while a failed analyzer is visible in the status', async () => {
    const report = await runAnalysis(makeInput({}), [
      throwing('boom'),
      fixedAnalyzer('ok', [signal({ analyzerId: 'ok' })]),
    ]);
    expect(report.signals.map((s) => s.analyzerId)).toEqual(['ok']);
    expect(report.analyzerStatus['boom']?.status).toBe('failed');
    expect(report.analyzerStatus['ok']?.status).toBe('ok');
  });

  it('truncates a long failure message so an analyzer cannot flood the report', async () => {
    const report = await runAnalysis(makeInput({}), [
      rawAnalyzer('long', () => {
        throw new Error('x'.repeat(10_000));
      }),
    ]);
    expect(report.analyzerStatus['long']?.message).toBe(`${'x'.repeat(200)}…`);
  });

  it('keeps a failure message of exactly 200 characters as is', async () => {
    const report = await runAnalysis(makeInput({}), [
      rawAnalyzer('edge', () => {
        throw new Error('y'.repeat(200));
      }),
    ]);
    expect(report.analyzerStatus['edge']?.message).toBe('y'.repeat(200));
  });

  it('records a thrown value that cannot be stringified as failed', async () => {
    const unprintable = {
      toString() {
        throw new Error('no string for you');
      },
    };
    const report = await runAnalysis(makeInput({}), [
      rawAnalyzer('odd', () => {
        throw unprintable;
      }),
    ]);
    expect(report.analyzerStatus['odd']).toEqual({ version: '1.0.0', status: 'failed', message: 'unprintable error' });
  });

  it('times out a never-settling analyzer and still resolves the report', async () => {
    const report = await runAnalysis(
      makeInput({}),
      [rawAnalyzer('hang', () => new Promise(() => {})), fixedAnalyzer('ok', [signal({ analyzerId: 'ok' })])],
      { timeoutMs: 50 }
    );
    expect(report.analyzerStatus['hang']?.status).toBe('timeout');
    expect(report.signals.map((s) => s.analyzerId)).toEqual(['ok']);
  });

  it('discards signals an analyzer delivers after its deadline', async () => {
    const late = rawAnalyzer(
      'late',
      () => new Promise((resolve) => setTimeout(() => resolve([signal({ analyzerId: 'late' })]), 100))
    );
    const report = await runAnalysis(makeInput({}), [late], { timeoutMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(report.signals).toEqual([]);
    expect(report.analyzerStatus['late']?.status).toBe('timeout');
  });

  it('leaves no pending deadline timer once every analyzer has settled', async () => {
    // タイマーが残ると、CLI の自然終了がその期限ぶん遅れる (verify-cli の不変条件 2)。
    vi.useFakeTimers();
    try {
      await runAnalysis(makeInput({}), [fixedAnalyzer('quick', []), throwing('boom')]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('defaults the per-analyzer deadline to 10 seconds', () => {
    expect(ANALYZER_TIMEOUT_MS).toBe(10_000);
  });

  it('records a non-array return value as invalid-output with no signals', async () => {
    const report = await runAnalysis(makeInput({}), [rawAnalyzer('obj', () => ({ signals: [] }))]);
    expect(report.analyzerStatus['obj']?.status).toBe('invalid-output');
    expect(report.signals).toEqual([]);
  });

  it('discards an infinite-score signal so it cannot raise reviewPriority', async () => {
    const report = await runAnalysis(makeInput({}), [
      fixedAnalyzer('inf', [signal({ analyzerId: 'inf', score: Number.POSITIVE_INFINITY })]),
    ]);
    expect(report.analyzerStatus['inf']).toMatchObject({ status: 'invalid-output', discardedSignals: 1 });
    expect(report.reviewPriority).toBe(0);
  });

  it('discards a NaN-confidence signal as invalid-output', async () => {
    const report = await runAnalysis(makeInput({}), [
      fixedAnalyzer('nan', [signal({ analyzerId: 'nan', confidence: Number.NaN })]),
    ]);
    expect(report.analyzerStatus['nan']?.status).toBe('invalid-output');
  });

  it('discards an unknown-severity signal and keeps reviewPriority finite', async () => {
    const report = await runAnalysis(makeInput({}), [
      fixedAnalyzer('crit', [signal({ analyzerId: 'crit', severity: 'critical' as never })]),
    ]);
    expect(report.analyzerStatus['crit']?.status).toBe('invalid-output');
    expect(Number.isFinite(report.reviewPriority)).toBe(true);
    expect(report.signals).toEqual([]);
  });

  it('discards a signal whose evidence is not an array', async () => {
    const report = await runAnalysis(makeInput({}), [
      fixedAnalyzer('ev', [signal({ analyzerId: 'ev', evidence: 'event 3' as never })]),
    ]);
    expect(report.analyzerStatus['ev']?.status).toBe('invalid-output');
  });

  it('discards a signal whose summary is not a string', async () => {
    const report = await runAnalysis(makeInput({}), [
      fixedAnalyzer('sum', [signal({ analyzerId: 'sum', summary: 42 as never })]),
    ]);
    expect(report.analyzerStatus['sum']?.status).toBe('invalid-output');
  });

  it('discards non-object entries in the returned array', async () => {
    const report = await runAnalysis(makeInput({}), [rawAnalyzer('junk', () => [null, 'signal', 3])]);
    expect(report.analyzerStatus['junk']).toMatchObject({ status: 'invalid-output', discardedSignals: 3 });
  });

  it('keeps the valid signals of an analyzer that also returned invalid ones', async () => {
    const report = await runAnalysis(makeInput({}), [
      fixedAnalyzer('mixed', [
        signal({ analyzerId: 'mixed', severity: 'notice', summary: 'kept' }),
        signal({ analyzerId: 'mixed', score: Number.NaN }),
      ]),
    ]);
    expect(report.signals.map((s) => s.summary)).toEqual(['kept']);
    expect(report.analyzerStatus['mixed']).toMatchObject({ status: 'invalid-output', discardedSignals: 1 });
    expect(report.reviewPriority).toBe(0.5);
  });

  it('still clamps finite out-of-range scores instead of discarding them', async () => {
    const report = await runAnalysis(makeInput({}), [fixedAnalyzer('big', [signal({ analyzerId: 'big', score: 5 })])]);
    expect(report.analyzerStatus['big']?.status).toBe('ok');
    expect(report.reviewPriority).toBe(1);
  });

  it('collects a very large analyzer output without exceeding the call stack', async () => {
    // 受け入れ条件は 10 万件。`push(...xs)` の引数展開は 12 万件前後で RangeError になるので、
    // その上の 20 万件で、出力の大きさが分析ごと落とさないことを見る。
    const many = Array.from({ length: 200_000 }, () => signal({ analyzerId: 'many', severity: 'info' }));
    const report = await runAnalysis(makeInput({}), [fixedAnalyzer('many', many)]);
    expect(report.analyzerStatus['many']?.status).toBe('ok');
    expect(report.signals).toHaveLength(200_000);
  });
});

describe('pureTypingAnalyzer (placeholder)', () => {
  it('emits a notice with evidence when non-pure typing has prohibited inputs', async () => {
    const report = await runAnalysis(
      makeInput({ isPureTyping: false, prohibitedInputs: ['insertFromPaste', 'insertFromDrop'] }),
      [pureTypingAnalyzer]
    );
    expect(report.signals).toHaveLength(1);
    expect(report.signals[0]!.evidence.length).toBe(2); // paste + drop の event index
    expect(report.signals[0]!.summaryParams).toMatchObject({ paste: 1, drop: 1 });
    expect(report.signals[0]?.severity).toBe('notice');
    expect(report.signals[0]?.dimension).toBe('transcription-topology');
  });

  it('stays silent when typing is pure', async () => {
    const report = await runAnalysis(makeInput({ isPureTyping: true }), [pureTypingAnalyzer]);
    expect(report.signals).toHaveLength(0);
  });

  it('flags a divergent contentSnapshot as bulk evidence (#175)', async () => {
    // 挿入イベント無しで replay 文書を丸ごと差し替える持ち込み口。bulk として数え、
    // evidence の note で snapshot 由来だと分かるようにする。
    const input = {
      proof: {
        proof: {
          events: [{ sequence: 0, timestamp: 0, type: 'contentSnapshot', data: 'int ai() {\n  return 42;\n}\n' }],
        },
      },
      verification: {
        valid: true,
        metadataValid: true,
        chainValid: true,
        isPureTyping: false,
      },
    } as unknown as AnalysisInput;
    const report = await runAnalysis(input, [pureTypingAnalyzer]);
    expect(report.signals).toHaveLength(1);
    expect(report.signals[0]!.summaryParams).toMatchObject({ paste: 0, drop: 0, bulk: 1 });
    expect(report.signals[0]!.evidence[0]?.note).toBe('divergent-content-snapshot');
  });
});

describe('runAnalysis hashed-field projection', () => {
  const blurEv = (t: number, seq: number) => ({
    sequence: seq,
    type: 'focusChange',
    timestamp: t,
    data: { focused: false },
  });
  const focusEv = (t: number, seq: number) => ({
    sequence: seq,
    type: 'focusChange',
    timestamp: t,
    data: { focused: true },
  });
  const insertEv = (t: number, seq: number, extra: Record<string, unknown>) => ({
    sequence: seq,
    type: 'contentChange',
    timestamp: t,
    inputType: 'insertText',
    data: 'x'.repeat(250),
    ...extra,
  });

  function inputWith(extra: Record<string, unknown>): AnalysisInput {
    const events = [blurEv(0, 0), focusEv(20_000, 1), insertEv(21_000, 2, extra)];
    return {
      proof: { proof: { events } } as unknown as AnalysisInput['proof'],
      verification: {
        valid: true,
        metadataValid: true,
        chainValid: true,
        isPureTyping: true,
      } as AnalysisInput['verification'],
    };
  }

  it('produces identical output when only unhashed event fields are rewritten', async () => {
    const baseline = await runAnalysis(inputWith({}));
    const tampered = await runAnalysis(
      inputWith({
        insertLength: 0,
        description: 'tampered',
        selectedText: 'tampered',
        insertedText: 'tampered',
        deletedLength: 9_999,
        isMultiLine: true,
        deleteDirection: 'forward',
      })
    );
    expect(baseline.signals.length).toBeGreaterThan(0);
    expect(tampered).toEqual(baseline);
  });

  it('hands analyzers events that carry only hashed fields', async () => {
    let seen: Record<string, unknown> | undefined;
    const spy: Analyzer = {
      id: 'spy',
      version: '1.0.0',
      analyze(input) {
        seen = input.proof.proof.events[2] as unknown as Record<string, unknown>;
        return [];
      },
    };
    await runAnalysis(inputWith({ insertLength: 7, description: 'd', selectedText: 's', unknownExtra: 1 }), [spy]);
    expect(seen).toBeDefined();
    expect(seen!.data).toBe('x'.repeat(250));
    for (const key of ['insertLength', 'description', 'selectedText', 'unknownExtra']) {
      expect(seen![key] ?? null).toBeNull();
    }
  });

  it('does not mutate the caller proof when projecting', async () => {
    const input = inputWith({ insertLength: 7 });
    await runAnalysis(input, []);
    expect((input.proof.proof.events[2] as unknown as { insertLength: number }).insertLength).toBe(7);
  });
});
