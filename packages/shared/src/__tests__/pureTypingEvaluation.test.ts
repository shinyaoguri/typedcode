/**
 * isPureTyping 判定の単一化 (#235) のテスト。
 *
 * export 側の自己申告 (`TypingProof.generateTypingProofHash`) と採点側の再計算
 * (`verifyProofMetadata`) が同じ関数を使うこと、括弧自動閉じのような editor 由来の
 * 複数文字挿入で自己申告が崩れないことを固定する。
 */

import { describe, expect, it } from 'vitest';
import { TypingProof, computeHash, verifyProofMetadata } from '../index.js';
import type { EventType, FingerprintComponents, InputType, ProofData, StoredEvent } from '../types.js';

const createMockFingerprintComponents = (): FingerprintComponents => ({
  userAgent: 'Mozilla/5.0 (PureTyping Test)',
  language: 'en',
  languages: ['en'],
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
  timezone: 'UTC',
  timezoneOffset: 0,
  canvas: 'mock-canvas',
  webgl: { vendor: 'Mock', renderer: 'Mock' },
  fonts: ['Arial'],
  cookieEnabled: true,
  doNotTrack: 'unspecified',
  maxTouchPoints: 0,
});

interface RecordedEvent {
  type: EventType;
  inputType: InputType;
  data: string;
  rangeOffset: number;
  rangeLength: number;
}

/**
 * Monaco の括弧自動閉じ (既定 `autoClosingBrackets: 'languageDefined'`) だけを含むセッション。
 * `(` の 1 打鍵で `()` が `insertReplacementText` として、閉じ括弧の type-over が
 * `replaceContent` として記録される。どちらも構造文字のみで内容 (コード) を運ばない。
 */
function autoClosingBracketSession(): RecordedEvent[] {
  return [
    { type: 'contentChange', inputType: 'insertText', data: 'f', rangeOffset: 0, rangeLength: 0 },
    { type: 'contentChange', inputType: 'insertText', data: 'o', rangeOffset: 1, rangeLength: 0 },
    { type: 'contentChange', inputType: 'insertText', data: 'o', rangeOffset: 2, rangeLength: 0 },
    // `(` を打つと editor が `()` を挿入する
    { type: 'contentChange', inputType: 'insertReplacementText', data: '()', rangeOffset: 3, rangeLength: 0 },
    // 自動で閉じた `)` の上から `)` を打つ (type-over)
    { type: 'contentChange', inputType: 'replaceContent', data: ')', rangeOffset: 4, rangeLength: 1 },
  ];
}

/** AI/スニペットによる複数行のコード一括投入 (打鍵で書いていない)。 */
function bulkCodeInsertSession(): RecordedEvent[] {
  return [
    { type: 'contentChange', inputType: 'insertText', data: 'f', rangeOffset: 0, rangeLength: 0 },
    {
      type: 'contentChange',
      inputType: 'insertParagraph',
      data: 'unction solve(n) {\n  return n < 2 ? n : solve(n - 1) + solve(n - 2);\n}\n',
      rangeOffset: 1,
      rangeLength: 0,
    },
  ];
}

function replayContent(events: RecordedEvent[]): string {
  let content = '';
  for (const event of events) {
    content = content.slice(0, event.rangeOffset) + event.data + content.slice(event.rangeOffset + event.rangeLength);
  }
  return content;
}

async function exportSession(events: RecordedEvent[]): Promise<{
  exportedIsPureTyping: boolean;
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
    storedEvents: exported.proof.events,
    proofData: exported.typingProofData,
  };
}

describe('isPureTyping single source of truth (#235)', () => {
  it('keeps the exported isPureTyping true for a session whose only multi-char inserts are auto-closing brackets', async () => {
    const { exportedIsPureTyping } = await exportSession(autoClosingBracketSession());
    expect(exportedIsPureTyping).toBe(true);
  });

  it('drops the exported isPureTyping to false for a multi-line bulk code insert', async () => {
    const { exportedIsPureTyping } = await exportSession(bulkCodeInsertSession());
    expect(exportedIsPureTyping).toBe(false);
  });

  it('agrees with the verifier recomputation on the same events', async () => {
    for (const session of [autoClosingBracketSession(), bulkCodeInsertSession()]) {
      const { exportedIsPureTyping, storedEvents, proofData } = await exportSession(session);
      const recomputed = verifyProofMetadata(proofData, storedEvents);
      expect(recomputed.valid).toBe(true);
      expect(recomputed.isPureTyping).toBe(exportedIsPureTyping);
    }
  });
});
