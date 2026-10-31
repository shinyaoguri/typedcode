import { describe, it, expect } from 'vitest';
import { focusBurstAnalyzer } from '../analysis/analyzers/focusBurstAnalyzer.js';
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

const blur = (t: number) => ({ type: 'focusChange', timestamp: t, data: { focused: false } });
const focus = (t: number) => ({ type: 'focusChange', timestamp: t, data: { focused: true } });
/** ハッシュ対象の `data` (挿入テキスト) で挿入量を表す。`insertLength` は署名対象外なので使わない。 */
const insert = (t: number, chars: number, extra: Record<string, unknown> = {}) => ({
  type: 'contentChange',
  timestamp: t,
  data: 'x'.repeat(chars),
  ...extra,
});

describe('focusBurstAnalyzer', () => {
  it('flags a large input burst right after a long absence', async () => {
    const events = [blur(0), focus(20_000), insert(21_000, 250)];
    const signals = await focusBurstAnalyzer.analyze(input(events));
    expect(signals).toHaveLength(1);
    expect(signals[0]?.dimension).toBe('focus-burst-correlation');
    expect(signals[0]?.evidence[0]?.fromEventIndex).toBe(1);
  });

  it('stays silent for a short absence', async () => {
    const events = [blur(0), focus(5_000), insert(6_000, 250)];
    const signals = await focusBurstAnalyzer.analyze(input(events));
    expect(signals).toHaveLength(0);
  });

  it('stays silent when the post-return burst is small', async () => {
    const events = [blur(0), focus(20_000), insert(21_000, 20)];
    const signals = await focusBurstAnalyzer.analyze(input(events));
    expect(signals).toHaveLength(0);
  });

  it('ignores inserts that fall outside the post-return window', async () => {
    const events = [blur(0), focus(20_000), insert(100_000, 500)];
    const signals = await focusBurstAnalyzer.analyze(input(events));
    expect(signals).toHaveLength(0);
  });

  it('ignores the unhashed insertLength field when counting the burst', async () => {
    const big = [blur(0), focus(20_000), insert(21_000, 250, { insertLength: 0 })];
    expect(await focusBurstAnalyzer.analyze(input(big))).toHaveLength(1);

    const small = [blur(0), focus(20_000), insert(21_000, 20, { insertLength: 9_999 })];
    expect(await focusBurstAnalyzer.analyze(input(small))).toHaveLength(0);
  });

  it('does not count non-string data as inserted characters', async () => {
    const events = [
      blur(0),
      focus(20_000),
      { type: 'contentChange', timestamp: 21_000, data: null, insertLength: 500 },
    ];
    expect(await focusBurstAnalyzer.analyze(input(events))).toHaveLength(0);
  });
});
