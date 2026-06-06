import { describe, it, expect } from 'vitest';
import { automationAnalyzer } from '../analysis/analyzers/automationAnalyzer.js';
import type { AnalysisInput } from '../analysis/types.js';

/** automationAnalyzer が触る最小フィールドだけを持つ AnalysisInput を組む。 */
function inputWith(opts: {
  probe?: { webdriver: boolean | null; automationGlobals: string[] };
  renderer?: string;
}): AnalysisInput {
  const events: unknown[] = [];
  if (opts.probe) {
    events.push({ sequence: 0, timestamp: 0, type: 'environmentProbe', data: opts.probe });
  }
  return {
    proof: {
      proof: { events },
      fingerprint: { components: { webgl: { unmaskedRenderer: opts.renderer } } },
    } as unknown as AnalysisInput['proof'],
    verification: {
      valid: true,
      metadataValid: true,
      chainValid: true,
      isPureTyping: true,
    } as AnalysisInput['verification'],
  };
}

describe('automationAnalyzer', () => {
  it('raises a review signal when navigator.webdriver is true', async () => {
    const signals = await automationAnalyzer.analyze(
      inputWith({ probe: { webdriver: true, automationGlobals: [] } })
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe('review');
    expect(signals[0]?.dimension).toBe('automation');
    expect(signals[0]?.evidence[0]?.fromEventIndex).toBe(0);
  });

  it('raises a review signal when automation globals are present', async () => {
    const signals = await automationAnalyzer.analyze(
      inputWith({ probe: { webdriver: false, automationGlobals: ['__playwright'] } })
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe('review');
    expect(signals[0]?.summary).toContain('__playwright');
  });

  it('raises a notice for a headless-style GPU renderer', async () => {
    const signals = await automationAnalyzer.analyze(
      inputWith({ probe: { webdriver: false, automationGlobals: [] }, renderer: 'Google SwiftShader' })
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe('notice');
  });

  it('stays silent on a clean environment', async () => {
    const signals = await automationAnalyzer.analyze(
      inputWith({
        probe: { webdriver: false, automationGlobals: [] },
        renderer: 'Apple M1 Pro',
      })
    );
    expect(signals).toHaveLength(0);
  });

  it('stays silent when no environment probe was captured', async () => {
    const signals = await automationAnalyzer.analyze(inputWith({ renderer: 'Apple M1 Pro' }));
    expect(signals).toHaveLength(0);
  });
});
