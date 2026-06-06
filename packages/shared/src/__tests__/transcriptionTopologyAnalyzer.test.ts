import { describe, it, expect } from 'vitest';
import { transcriptionTopologyAnalyzer } from '../analysis/analyzers/transcriptionTopologyAnalyzer.js';
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

/** n 件の contentChange を作り、先頭 deletions 件を削除イベントにする。 */
function contentEvents(n: number, deletions: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({
    type: 'contentChange',
    inputType: i < deletions ? 'deleteContentBackward' : 'insertText',
    insertLength: 1,
  }));
}

describe('transcriptionTopologyAnalyzer', () => {
  it('flags an almost-zero revision rate over substantial editing', async () => {
    const signals = await transcriptionTopologyAnalyzer.analyze(input(contentEvents(200, 1)));
    expect(signals).toHaveLength(1);
    expect(signals[0]?.dimension).toBe('transcription-topology');
    expect(signals[0]?.severity).toBe('notice');
  });

  it('stays silent when revisions are present', async () => {
    const signals = await transcriptionTopologyAnalyzer.analyze(input(contentEvents(200, 40)));
    expect(signals).toHaveLength(0);
  });

  it('stays silent on a sample too small to judge', async () => {
    const signals = await transcriptionTopologyAnalyzer.analyze(input(contentEvents(50, 0)));
    expect(signals).toHaveLength(0);
  });
});
