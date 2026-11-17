/**
 * IME の composition と直接挿入の分類 (#720) について、shared の判定が変わっていないことを固定する。
 *
 * #720 は editor の記録側だけの修正で、`isSuspiciousBulkInsert` / `evaluatePureTyping` /
 * `summarizeProcess` の式と `InputType` の値域は変えない。editor は composition に対応付かない
 * 複数文字・単一行の挿入を (文字種によらず) `insertReplacementText` と記録するようになり、それが
 * 既存の一括挿入の評価に掛かること、真正な composition 系の記録は長さによらず Pure Typing を崩さない
 * こと、旧 proof の `insertFromComposition` を文字種で読み直さないことをここで見る。
 */

import { describe, expect, it } from 'vitest';
import { TypingProof, computeHash, summarizeProcess, verifyProofMetadata } from '../index.js';
import { MAX_BENIGN_SINGLE_LINE_INSERT_CHARS, evaluatePureTyping } from '../typingProof/structuralEdit.js';
import type { FingerprintComponents, InputType, ProofData, StoredEvent } from '../types.js';

/** #720 の再現入力: 日本語 1 文字入りの単一行 (346 文字)。 */
const ISSUE_720_DIRECT_INSERT = `int main(){${'int x=1;'.repeat(40)}return 0;} // あ`;

interface RecordedEvent {
  type: 'contentChange';
  inputType: InputType;
  data: string;
  rangeOffset: number;
  rangeLength: number;
}

/** 検証で使うフィールドだけの StoredEvent。ハッシュは判定に使わない。 */
function stored(events: RecordedEvent[]): StoredEvent[] {
  return events.map(
    (event, i) =>
      ({
        ...event,
        sequence: i,
        timestamp: i * 100,
        hash: '',
        previousHash: '',
      }) as unknown as StoredEvent
  );
}

/** `// ` を打鍵してから、指定の挿入を 1 件入れたセッション。 */
function sessionWith(inputType: InputType, data: string): RecordedEvent[] {
  return [
    { type: 'contentChange', inputType: 'insertText', data: '/', rangeOffset: 0, rangeLength: 0 },
    { type: 'contentChange', inputType: 'insertText', data: '/', rangeOffset: 1, rangeLength: 0 },
    { type: 'contentChange', inputType: 'insertText', data: ' ', rangeOffset: 2, rangeLength: 0 },
    { type: 'contentChange', inputType, data, rangeOffset: 3, rangeLength: 0 },
  ];
}

/** CDP の合成 composition で観測した形: preedit が 1 文字ずつ伸び、確定がその範囲を置き換える。 */
function longCompositionSession(length: number): RecordedEvent[] {
  const events: RecordedEvent[] = [];
  for (let i = 0; i < length; i++) {
    events.push({
      type: 'contentChange',
      inputType: 'insertCompositionText',
      data: 'あ',
      rangeOffset: i,
      rangeLength: 0,
    });
  }
  events.push({
    type: 'contentChange',
    inputType: 'insertCompositionText',
    data: '亜'.repeat(length),
    rangeOffset: 0,
    rangeLength: length,
  });
  return events;
}

describe('direct insert without composition (#720)', () => {
  it('counts the #720 direct insert recorded as insertReplacementText once as a non-benign bulk insert', () => {
    const events = stored(sessionWith('insertReplacementText', ISSUE_720_DIRECT_INSERT));
    const evaluation = evaluatePureTyping(events);

    expect(ISSUE_720_DIRECT_INSERT.length).toBe(346);
    expect(evaluation.suspiciousBulkInsertEventIndexes).toEqual([3]);
    expect(evaluation.nonBenignBulkInsertCount).toBe(1);
    expect(evaluation.isPureTyping).toBe(false);
  });

  it('counts the #720 direct insert recorded as insertReplacementText once as external input', () => {
    expect(
      summarizeProcess(stored(sessionWith('insertReplacementText', ISSUE_720_DIRECT_INSERT))).externalInputCount
    ).toBe(1);
  });
});

describe('genuine composition records (#720)', () => {
  it('keeps Pure Typing for an insertCompositionText longer than the single-line benign cap', () => {
    const length = MAX_BENIGN_SINGLE_LINE_INSERT_CHARS + 30;
    const events = stored(longCompositionSession(length));

    expect(evaluatePureTyping(events).isPureTyping).toBe(true);
    expect(summarizeProcess(events).externalInputCount).toBe(0);
  });

  it('does not count any of the three composition input types as a bulk insert', () => {
    const events = stored([
      { type: 'contentChange', inputType: 'insertCompositionText', data: 'にほん', rangeOffset: 0, rangeLength: 0 },
      { type: 'contentChange', inputType: 'deleteCompositionText', data: '', rangeOffset: 0, rangeLength: 3 },
      { type: 'contentChange', inputType: 'insertFromComposition', data: '日本', rangeOffset: 0, rangeLength: 0 },
    ]);

    expect(evaluatePureTyping(events).suspiciousBulkInsertEventIndexes).toEqual([]);
  });
});

describe('old proofs (#720)', () => {
  it('does not reinterpret a long insertFromComposition of an old proof by its characters', () => {
    // #720 以前の editor が文字種だけで付けた形。検証側は inputType をそのまま読む (読み直さない)。
    const events = stored(sessionWith('insertFromComposition', ISSUE_720_DIRECT_INSERT));
    const evaluation = evaluatePureTyping(events);

    expect(evaluation.suspiciousBulkInsertEventIndexes).toEqual([]);
    expect(evaluation.isPureTyping).toBe(true);
    expect(summarizeProcess(events).externalInputCount).toBe(0);
  });
});

const createMockFingerprintComponents = (): FingerprintComponents => ({
  userAgent: 'Mozilla/5.0 (Composition Test)',
  language: 'ja',
  languages: ['ja'],
  platform: 'TestOS',
  hardwareConcurrency: 4,
  deviceMemory: 8,
  screen: {
    width: 1440,
    height: 900,
    availWidth: 1440,
    availHeight: 860,
    colorDepth: 24,
    pixelDepth: 24,
    devicePixelRatio: 2,
  },
  timezone: 'Asia/Tokyo',
  timezoneOffset: -540,
  canvas: 'mock-canvas',
  webgl: { vendor: 'Mock', renderer: 'Mock' },
  fonts: ['Arial'],
  cookieEnabled: true,
  doNotTrack: 'unspecified',
  maxTouchPoints: 0,
});

function replayContent(events: RecordedEvent[]): string {
  let content = '';
  for (const event of events) {
    content = content.slice(0, event.rangeOffset) + event.data + content.slice(event.rangeOffset + event.rangeLength);
  }
  return content;
}

async function exportSession(events: RecordedEvent[]): Promise<{
  exportedIsPureTyping: boolean;
  exportedBulkInsertEvents: number | undefined;
  storedEvents: StoredEvent[];
  proofData: ProofData;
}> {
  const components = createMockFingerprintComponents();
  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const proof = new TypingProof();
  await proof.initialize(fingerprintHash, components);
  for (const event of events) {
    await proof.recordEvent(event);
  }
  const exported = await proof.exportProof(replayContent(events));
  return {
    exportedIsPureTyping: exported.metadata.isPureTyping,
    exportedBulkInsertEvents: exported.typingProofData.metadata.bulkInsertEvents,
    storedEvents: exported.proof.events,
    proofData: exported.typingProofData,
  };
}

describe('self-report and verifier recomputation with composition (#720)', () => {
  it('agrees on isPureTyping and bulkInsertEvents for a session mixing composition and a direct insert', async () => {
    const events: RecordedEvent[] = [
      ...longCompositionSession(3),
      { type: 'contentChange', inputType: 'deleteCompositionText', data: '', rangeOffset: 0, rangeLength: 3 },
      { type: 'contentChange', inputType: 'insertFromComposition', data: '日本', rangeOffset: 0, rangeLength: 0 },
      {
        type: 'contentChange',
        inputType: 'insertReplacementText',
        data: ISSUE_720_DIRECT_INSERT,
        rangeOffset: 2,
        rangeLength: 0,
      },
    ];
    const { exportedIsPureTyping, exportedBulkInsertEvents, storedEvents, proofData } = await exportSession(events);
    const recomputed = verifyProofMetadata(proofData, storedEvents);

    expect(recomputed.valid).toBe(true);
    expect(exportedBulkInsertEvents).toBe(1);
    expect(exportedIsPureTyping).toBe(false);
    expect(recomputed.isPureTyping).toBe(exportedIsPureTyping);
  });
});
