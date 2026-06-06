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
const insert = (t: number, chars: number) => ({
  type: 'contentChange',
  timestamp: t,
  insertLength: chars,
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
});
