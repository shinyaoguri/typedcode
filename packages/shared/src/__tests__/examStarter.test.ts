/**
 * #718: 試験の封印 starter と proof の templateInjection の照合 (`matchExamStarter`)。
 *
 * 規則 (docs/system-spec.md の exam 束縛検証):
 * - starter が空: templateInjection が 1 つでもあれば mismatch
 * - starter が非空: すべての注入の content が starter と一致すれば matched (注入なし・複数・再注入も)
 * - content 不一致・data 不正は mismatch で、最初の 1 つの eventIndex を返す
 * - 自己申告の templateName / templateHash / contentHash / contentLength は見ない
 */

import { describe, expect, it } from 'vitest';
import { matchExamStarter, type ExamStarterEventLike, type StoredEvent } from '../index.js';
import { evaluatePureTyping } from '../typingProof/structuralEdit.js';

const STARTER = '/* TODO */\n';
const FORGED = '#include <stdio.h>\nint main(void) { printf("42\\n"); return 0; }\n';

function injection(content: unknown, overrides: Record<string, unknown> = {}): ExamStarterEventLike {
  return {
    type: 'templateInjection',
    data: {
      templateName: 'exam/p1',
      templateHash: 'a'.repeat(64),
      filename: 'p1.c',
      content,
      contentHash: 'b'.repeat(64),
      contentLength: typeof content === 'string' ? content.length : 0,
      totalFilesInTemplate: 1,
      injectionSource: 'file_import',
      ...overrides,
    },
  };
}

function typed(data: string, rangeOffset: number): ExamStarterEventLike & Record<string, unknown> {
  return { type: 'contentChange', inputType: 'insertText', data, rangeOffset, rangeLength: 0 };
}

const attestation: ExamStarterEventLike = { type: 'humanAttestation', data: {} };
const examOpened: ExamStarterEventLike = { type: 'examOpened', data: {} };

describe('matchExamStarter', () => {
  it('matches a single injection whose content equals the sealed starter (the canonical editor shape)', () => {
    const result = matchExamStarter([attestation, examOpened, injection(STARTER)], STARTER);
    expect(result).toEqual({ status: 'matched' });
  });

  it('matches a proof with no injection when the sealed starter is non-empty', () => {
    const result = matchExamStarter([attestation, examOpened, typed('x', 0)], STARTER);
    expect(result.status).toBe('matched');
  });

  it('matches a proof with no injection when the sealed problem has no starter', () => {
    const result = matchExamStarter([attestation, examOpened, typed('x', 0)], '');
    expect(result.status).toBe('matched');
  });

  it('rejects any injection when the sealed problem has no starter, reporting its event index', () => {
    const result = matchExamStarter([attestation, examOpened, injection(FORGED)], '');
    expect(result).toMatchObject({ status: 'mismatch', eventIndex: 2 });
    expect(result.reason).toBe('Template injection at event 2 is present but the sealed problem has no starter');
  });

  it('rejects even an empty-content injection when the sealed problem has no starter', () => {
    const result = matchExamStarter([attestation, injection('')], '');
    expect(result).toMatchObject({ status: 'mismatch', eventIndex: 1 });
  });

  it('rejects an injection whose content differs from the sealed starter, reporting its event index', () => {
    const result = matchExamStarter([attestation, examOpened, injection(FORGED)], STARTER);
    expect(result).toMatchObject({ status: 'mismatch', eventIndex: 2 });
    expect(result.reason).toBe('Template injection at event 2 does not match the sealed starter');
  });

  it('rejects an injection appended after a matching one (post-hoc injection of other content)', () => {
    const events = [attestation, examOpened, injection(STARTER), typed('x', 0), injection(FORGED)];
    const result = matchExamStarter(events, STARTER);
    expect(result).toMatchObject({ status: 'mismatch', eventIndex: 4 });
  });

  it('reports the first mismatching injection when several mismatch', () => {
    const events = [attestation, injection(FORGED), injection('other')];
    expect(matchExamStarter(events, STARTER).eventIndex).toBe(1);
  });

  it('matches multiple injections and a re-injection after edits when every content equals the starter', () => {
    const events = [attestation, examOpened, injection(STARTER), typed('x', 0), injection(STARTER)];
    expect(matchExamStarter(events, STARTER).status).toBe('matched');
  });

  it('rejects an injection whose data is not a { content: string } object', () => {
    const result = matchExamStarter([attestation, { type: 'templateInjection', data: { content: 42 } }], STARTER);
    expect(result).toMatchObject({ status: 'mismatch', eventIndex: 1 });
    expect(result.reason).toBe('Template injection at event 1 has invalid data');
  });

  it('rejects an injection with missing data', () => {
    const result = matchExamStarter([{ type: 'templateInjection' }], STARTER);
    expect(result).toMatchObject({ status: 'mismatch', eventIndex: 0 });
  });

  it('ignores self-asserted name/hash/length fields that claim the starter when the content differs', () => {
    const lying = injection(FORGED, {
      templateName: 'exam/p1',
      contentHash: 'c'.repeat(64),
      contentLength: STARTER.length,
    });
    expect(matchExamStarter([attestation, lying], STARTER).status).toBe('mismatch');
  });

  it('matches the canonical starter followed by a one-character edit', () => {
    const events = [attestation, examOpened, injection(STARTER), typed('a', STARTER.length)];
    expect(matchExamStarter(events, STARTER).status).toBe('matched');
  });

  it('skips null entries of an untrusted event list instead of throwing', () => {
    const events = [null, injection(STARTER)] as unknown as ExamStarterEventLike[];
    expect(matchExamStarter(events, STARTER).status).toBe('matched');
  });

  it('does not treat a non-injection event carrying a content field as an injection', () => {
    const events = [attestation, { type: 'contentSnapshot', data: { content: FORGED } }];
    expect(matchExamStarter(events, '').status).toBe('matched');
  });
});

describe('matchExamStarter — contentSnapshot is not a silent bypass', () => {
  it('a divergent contentSnapshot after the canonical starter breaks pure typing (#175)', () => {
    // starter 照合は templateInjection だけを見る。contentSnapshot での全文置換は照合を通るが、
    // 既に isDivergentContentSnapshot で isPureTyping=false になる (サイレントな迂回ではない)。
    const events = [
      { ...attestation, inputType: null, timestamp: 0 },
      { ...injection(STARTER), inputType: null, timestamp: 1 },
      { ...typed('a', STARTER.length), timestamp: 2 },
      { type: 'contentSnapshot', inputType: null, data: FORGED, timestamp: 3 },
    ] as unknown as StoredEvent[];
    expect(matchExamStarter(events, STARTER).status).toBe('matched');
    expect(evaluatePureTyping(events).isPureTyping).toBe(false);
  });

  it('the canonical starter followed by typing keeps pure typing (control for the case above)', () => {
    const events = [
      { ...attestation, inputType: null, timestamp: 0 },
      { ...injection(STARTER), inputType: null, timestamp: 1 },
      { ...typed('a', STARTER.length), timestamp: 2 },
    ] as unknown as StoredEvent[];
    expect(evaluatePureTyping(events).isPureTyping).toBe(true);
  });
});
