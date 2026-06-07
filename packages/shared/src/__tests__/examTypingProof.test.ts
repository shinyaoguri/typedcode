/**
 * ADR-0006: TypingProof の exam モード永続化テスト。
 * examContext が serializeState / serializeLightweightState / restoreState を
 * 跨いで round-trip することを保証する (editor のリロード復元で束縛が失われないため)。
 */

import { describe, expect, it } from 'vitest';
import { TypingProof, type ExamSessionContext, type FingerprintComponents } from '../index.js';

const FP = 'f'.repeat(64);
const COMPONENTS = { lang: 'ja-JP' } as unknown as FingerprintComponents;
const EXAM_CONTEXT: ExamSessionContext = {
  examId: 'e1',
  problemId: 'p1',
  variant: null,
  packageHash: 'a'.repeat(64),
  problemContentHash: 'b'.repeat(64),
  startToken: 'ABCD1234',
};

describe('TypingProof exam-mode persistence', () => {
  it('holds examContext after initializeExam and binds the root to it', async () => {
    const tp = new TypingProof();
    await tp.initializeExam(FP, COMPONENTS, EXAM_CONTEXT);
    expect(tp.examContext).toEqual(EXAM_CONTEXT);
    expect(tp.getInitialEventChainHash()).toBe(tp.currentHash);
  });

  it('includes examContext in serializeState and serializeLightweightState', async () => {
    const tp = new TypingProof();
    await tp.initializeExam(FP, COMPONENTS, EXAM_CONTEXT);
    expect(tp.serializeState().examContext).toEqual(EXAM_CONTEXT);
    expect(tp.serializeLightweightState().examContext).toEqual(EXAM_CONTEXT);
  });

  it('restores examContext from a serialized state (reload path)', async () => {
    const tp = new TypingProof();
    await tp.initializeExam(FP, COMPONENTS, EXAM_CONTEXT);
    const state = tp.serializeState();

    const restored = new TypingProof();
    restored.restoreState({
      events: [],
      currentHash: state.currentHash,
      initialHashNonce: state.initialHashNonce,
      startTime: state.startTime,
      checkpoints: [],
      examContext: state.examContext,
    });
    expect(restored.examContext).toEqual(EXAM_CONTEXT);
  });

  it('leaves examContext null for casual initialize', async () => {
    const tp = new TypingProof();
    await tp.initialize(FP, COMPONENTS);
    expect(tp.examContext).toBeNull();
    expect(tp.serializeLightweightState().examContext).toBeNull();
  });
});
