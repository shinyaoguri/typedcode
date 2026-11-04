import { describe, it, expect } from 'vitest';
import { runAnalysis } from '../analysis/orchestrator.js';
import { defaultAnalyzers, templateInjectionAnalyzer } from '../analysis/analyzers/index.js';
import { summarizeAnalysisForAssurance } from '../assurance.js';
import type { AnalysisInput } from '../analysis/types.js';

function input(events: unknown[]): AnalysisInput {
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

/** ハッシュ対象の `data.content` で注入量を表す。`contentLength` は自己申告なので既定では実長にしない。 */
const inject = (t: number, chars: number, extra: Record<string, unknown> = {}) => ({
  type: 'templateInjection',
  timestamp: t,
  data: {
    templateName: 't',
    filename: 'main.c',
    content: 'x'.repeat(chars),
    contentLength: chars,
    injectionSource: 'file_import',
    ...extra,
  },
});
/** ハッシュ対象の `data` (挿入テキスト) で打った量を表す。`insertLength` は署名対象外なので使わない。 */
const type = (t: number, chars: number, extra: Record<string, unknown> = {}) => ({
  type: 'contentChange',
  timestamp: t,
  data: 'y'.repeat(chars),
  inputType: 'insertText',
  ...extra,
});

describe('templateInjectionAnalyzer', () => {
  it('emits one signal carrying both the template and typed character counts', async () => {
    const report = await runAnalysis(input([inject(0, 500), type(1000, 10)]));
    const signals = report.signals.filter((s) => s.analyzerId === 'template-injection');
    expect(signals).toHaveLength(1);
    expect(signals[0]?.summaryKey).toBe('analysis.summary.templateInjection');
    expect(signals[0]?.summaryParams).toEqual({ template: 500, typed: 10 });
    expect(signals[0]?.summary).toContain('500');
    expect(signals[0]?.summary).toContain('10');
  });

  it('stays silent when the proof has no templateInjection', async () => {
    const report = await runAnalysis(input([type(0, 10), type(1000, 20)]));
    expect(report.signals.some((s) => s.analyzerId === 'template-injection')).toBe(false);
  });

  it('counts data.content.length, not the self-reported contentLength', async () => {
    const signals = await templateInjectionAnalyzer.analyze(input([inject(0, 500, { contentLength: 0 })]));
    expect(signals[0]?.summaryParams).toEqual({ template: 500, typed: 0 });
  });

  it('does not inflate the count when contentLength overstates the content', async () => {
    const signals = await templateInjectionAnalyzer.analyze(input([inject(0, 5, { contentLength: 9_999 })]));
    expect(signals[0]?.summaryParams?.['template']).toBe(5);
  });

  it('counts typed characters from data and ignores the unhashed insertLength', async () => {
    const signals = await templateInjectionAnalyzer.analyze(
      input([inject(0, 500), type(1000, 10, { insertLength: 9_999 })])
    );
    expect(signals[0]?.summaryParams?.['typed']).toBe(10);
  });

  it('sums the characters of every templateInjection event and points at each one', async () => {
    const signals = await templateInjectionAnalyzer.analyze(input([inject(0, 300), type(500, 4), inject(1000, 200)]));
    expect(signals[0]?.summaryParams).toEqual({ template: 500, typed: 4 });
    expect(signals[0]?.evidence.map((e) => e.fromEventIndex)).toEqual([0, 2]);
  });

  it('stays silent when the injected content is empty', async () => {
    expect(await templateInjectionAnalyzer.analyze(input([inject(0, 0), type(1000, 10)]))).toHaveLength(0);
  });

  it('skips a templateInjection whose data has no string content', async () => {
    const malformed = { type: 'templateInjection', timestamp: 0, data: { contentLength: 500 } };
    expect(await templateInjectionAnalyzer.analyze(input([malformed, type(1000, 10)]))).toHaveLength(0);
  });

  it('does not point at a malformed templateInjection next to a valid one', async () => {
    const malformed = { type: 'templateInjection', timestamp: 0, data: { contentLength: 500 } };
    const signals = await templateInjectionAnalyzer.analyze(input([malformed, inject(1000, 40)]));
    expect(signals[0]?.evidence.map((e) => e.fromEventIndex)).toEqual([1]);
  });

  it('emits an info signal in an existing dimension', async () => {
    const [signal] = await templateInjectionAnalyzer.analyze(input([inject(0, 500)]));
    expect(signal?.severity).toBe('info');
    expect(signal?.dimension).toBe('transcription-topology');
  });

  it('leaves reviewPriority and notableSignals unchanged by adding the signal', async () => {
    const proof = input([inject(0, 500), type(1000, 10)]);
    const without = defaultAnalyzers.filter((a) => a.id !== templateInjectionAnalyzer.id);
    const before = await runAnalysis(proof, without);
    const after = await runAnalysis(proof);

    expect(after.signals.length).toBe(before.signals.length + 1);
    expect(after.reviewPriority).toBe(before.reviewPriority);
    expect(summarizeAnalysisForAssurance(after)?.notableSignals).toBe(
      summarizeAnalysisForAssurance(before)?.notableSignals
    );
  });
});
