import { describe, it, expect } from 'vitest';
import {
  getEditorAssistDeclaration,
  isBenignEditorInsert,
  isMultiLineBulkInsert,
  isFlaggedBulkInsert,
  SessionProvenanceLedger,
  isSuspiciousBulkInsert,
  MAX_BENIGN_SINGLE_LINE_INSERT_CHARS,
} from '../structuralEdit.js';
import { StatisticsCalculator } from '../StatisticsCalculator.js';
import type { StoredEvent, EditorAssistDeclaration } from '../../types.js';

function insert(data: unknown, inputType: string, rangeLength = 0): StoredEvent {
  return { type: 'contentChange', inputType, data, rangeLength } as unknown as StoredEvent;
}

describe('isBenignEditorInsert', () => {
  it('accepts an auto-closed bracket pair (insertReplacementText "()")', () => {
    expect(isBenignEditorInsert(insert('()', 'insertReplacementText'))).toBe(true);
  });

  it('accepts a type-over of a single closing bracket (replaceContent ")")', () => {
    expect(isBenignEditorInsert(insert(')', 'replaceContent', 1))).toBe(true);
  });

  it('accepts an auto-dedent that re-inserts a single brace (replaceContent "}")', () => {
    expect(isBenignEditorInsert(insert('}', 'replaceContent', 6))).toBe(true);
  });

  it('accepts a single-line identifier completion (Tab/IntelliSense)', () => {
    expect(isBenignEditorInsert(insert('printf', 'insertReplacementText'))).toBe(true);
  });

  it('accepts a single-line completion that contains operators and spaces', () => {
    expect(isBenignEditorInsert(insert('result = a + b;', 'insertReplacementText'))).toBe(true);
  });

  it('accepts a single-line completion up to the length cap (#139)', () => {
    const atCap = 'x'.repeat(MAX_BENIGN_SINGLE_LINE_INSERT_CHARS);
    expect(isBenignEditorInsert(insert(atCap, 'insertReplacementText'))).toBe(true);
  });

  it('rejects a single-line insert longer than the cap (minified one-liner laundering, #139)', () => {
    const oneLiner = 'const f=(n)=>n<2?n:f(n-1)+f(n-2);'.repeat(10); // 330 chars, no newline
    expect(isBenignEditorInsert(insert(oneLiner, 'insertText'))).toBe(false);
    expect(isBenignEditorInsert(insert('y'.repeat(MAX_BENIGN_SINGLE_LINE_INSERT_CHARS + 1), 'insertReplacementText'))).toBe(false);
  });

  it('keeps structural-only inserts benign regardless of length (they cannot carry code)', () => {
    expect(isBenignEditorInsert(insert(' '.repeat(500), 'insertText'))).toBe(true);
  });

  it('accepts whitespace-only multi-line auto-indent', () => {
    expect(isBenignEditorInsert(insert('\r\n    \r\n', 'insertText'))).toBe(true);
  });

  it('rejects a multi-line code block (AI/snippet bulk insertion)', () => {
    expect(isBenignEditorInsert(insert('int f() {\n  return 0;\n}', 'insertReplacementText'))).toBe(false);
  });

  it('rejects a real paste (paste is not an editor-internal insert)', () => {
    expect(isBenignEditorInsert(insert('printf', 'insertFromPaste'))).toBe(false);
  });

  it('accepts a whitespace-only insertParagraph (auto-indent expansion)', () => {
    expect(isBenignEditorInsert(insert('\r\n      ', 'insertParagraph'))).toBe(true);
  });

  it('rejects a code-bearing insertParagraph (AI/snippet multi-line block)', () => {
    expect(isBenignEditorInsert(insert('x = 1;\n  y = 2;', 'insertParagraph'))).toBe(false);
  });

  it('rejects an empty insert', () => {
    expect(isBenignEditorInsert(insert('', 'insertText'))).toBe(false);
  });
});

describe('isMultiLineBulkInsert', () => {
  it('flags a multi-line code block inserted at once (the AI-via-Tab vector)', () => {
    expect(isMultiLineBulkInsert(insert('int f() {\n  return 0;\n}', 'insertReplacementText'))).toBe(true);
  });

  it('flags a multi-line replaceContent with code content', () => {
    expect(isMultiLineBulkInsert(insert('a;\nb;', 'replaceContent', 3))).toBe(true);
  });

  it('does NOT flag whitespace-only multi-line auto-indent (no code content)', () => {
    expect(isMultiLineBulkInsert(insert('\r\n    \r\n', 'insertText'))).toBe(false);
  });

  it('does NOT flag a single-line completion', () => {
    expect(isMultiLineBulkInsert(insert('result = a + b;', 'insertReplacementText'))).toBe(false);
  });

  it('does NOT flag a real multi-line paste (handled as paste, not editor-internal)', () => {
    expect(isMultiLineBulkInsert(insert('a;\nb;', 'insertFromPaste'))).toBe(false);
  });

  it('flags a code-bearing insertParagraph (programmatic / AI multi-line insertion)', () => {
    expect(isMultiLineBulkInsert(insert('int r = a * b;\n  return r;', 'insertParagraph'))).toBe(true);
  });

  it('does NOT flag a whitespace-only insertParagraph (auto-indent has no code)', () => {
    expect(isMultiLineBulkInsert(insert('\r\n    \r\n', 'insertParagraph'))).toBe(false);
  });
});

describe('isFlaggedBulkInsert (内部ペースト除外)', () => {
  const code = 'int helper = 7;\r\n';

  it('flags an AI/external multi-line block that is not session-derived', () => {
    expect(isFlaggedBulkInsert(insert(code, 'insertParagraph'), false)).toBe(true);
  });

  it('does NOT flag a multi-line insert verified as session-derived', () => {
    expect(isFlaggedBulkInsert(insert(code, 'insertParagraph'), true)).toBe(false);
  });
});

describe('SessionProvenanceLedger (#138: 内部ペーストの内容はセッション由来を replay で検証する)', () => {
  const code = 'int helper = 7;\n';

  function typed(data: string, rangeOffset: number, rangeLength = 0): StoredEvent {
    return { type: 'contentChange', inputType: 'insertText', data, rangeOffset, rangeLength } as unknown as StoredEvent;
  }
  function copyOp(data: string): StoredEvent {
    return { type: 'copyOperation', inputType: null, data } as unknown as StoredEvent;
  }
  function run(events: StoredEvent[]): boolean[] {
    const ledger = new SessionProvenanceLedger();
    return events.map((e) => ledger.checkAndApply(e));
  }

  it('accepts a re-insertion of content present in the document before the event', () => {
    const results = run([typed(code, 0), typed(code, code.length)]);
    expect(results[1]).toBe(true);
  });

  it('accepts content matching a verified copyOperation even after the original was deleted', () => {
    const deleteAll = { type: 'contentChange', inputType: 'deleteContentBackward', data: '', rangeOffset: 0, rangeLength: code.length } as unknown as StoredEvent;
    const results = run([typed(code, 0), copyOp(code), deleteAll, typed(code, 0)]);
    expect(results[1]).toBe(true); // copy 時点で文書に実在 → 検証済みコピー
    expect(results[3]).toBe(true); // 削除後でもコピー由来として許可 (editor の copiedContent と同じ)
  });

  it('rejects content that never existed in the session (marker laundering, #138)', () => {
    const ai = 'int ai() {\n  return 42;\n}\n';
    const marker = { type: 'contentChange', inputType: 'insertFromInternalPaste', data: ai, rangeOffset: null, rangeLength: 0 } as unknown as StoredEvent;
    const insertion = { type: 'contentChange', inputType: 'insertParagraph', data: ai, rangeOffset: 9, rangeLength: 0 } as unknown as StoredEvent;
    const results = run([typed('unrelated', 0), marker, insertion]);
    expect(results[1]).toBe(false); // マーカー (自己申告) は根拠にならない
    expect(results[2]).toBe(false); // 実挿入もセッション由来と認めない
  });

  it('rejects an insertion whose only evidence is the insertion itself (insertion-then-marker reordering)', () => {
    // 事前パスの許可リスト方式だと「実挿入 → マーカー」の並べ替えで挿入後の文書を根拠に
    // 自己検証できた。逐次判定 (適用前の状態) はこれを塞ぐ。
    const ai = 'int ai() {\n  return 42;\n}\n';
    const insertion = { type: 'contentChange', inputType: 'insertParagraph', data: ai, rangeOffset: 0, rangeLength: 0 } as unknown as StoredEvent;
    const marker = { type: 'contentChange', inputType: 'insertFromInternalPaste', data: ai, rangeOffset: null, rangeLength: 0 } as unknown as StoredEvent;
    const results = run([insertion, marker]);
    expect(results[0]).toBe(false);
  });

  it('does not trust a fabricated copyOperation whose content was not in the document', () => {
    const ai = 'int ai() {\n  return 42;\n}\n';
    const results = run([typed('unrelated', 0), copyOp(ai), typed(ai, 9)]);
    expect(results[1]).toBe(false);
    expect(results[2]).toBe(false);
  });

  it('does not absorb a divergent contentSnapshot, so smuggled content is never session-derived (#175)', () => {
    // 乖離 snapshot で AI 解答を持ち込み、その部分文字列を「内部ペースト」として挿入する迂回路。
    const ai = 'int ai() {\n  return 42;\n}\n';
    const snapshot = { type: 'contentSnapshot', inputType: null, data: ai } as unknown as StoredEvent;
    const insertion = { type: 'contentChange', inputType: 'insertParagraph', data: ai, rangeOffset: 0, rangeLength: 0 } as unknown as StoredEvent;
    const results = run([snapshot, insertion]);
    expect(results[1]).toBe(false);
  });

  it('treats a matching contentSnapshot as a provenance no-op (the regular 100-event snapshot)', () => {
    const snapshot = { type: 'contentSnapshot', inputType: null, data: code } as unknown as StoredEvent;
    const results = run([typed(code, 0), snapshot, typed(code, code.length)]);
    expect(results[2]).toBe(true); // snapshot を挟んでも文書由来の再挿入は引き続き許可
  });
});

describe('getEditorAssistDeclaration', () => {
  function assist(): EditorAssistDeclaration {
    return {
      schema: 'editor-assist/1',
      quickSuggestions: null,
      suggestOnTriggerCharacters: null,
      wordBasedSuggestions: null,
      snippetSuggestions: null,
      inlineSuggest: null,
      tabCompletion: null,
      acceptSuggestionOnEnter: null,
      parameterHints: null,
      autoClosingBrackets: 'languageDefined',
      autoClosingQuotes: 'languageDefined',
      autoSurround: 'languageDefined',
      formatOnType: null,
      formatOnPaste: null,
    };
  }

  it('extracts the declaration from the environmentProbe event', () => {
    const decl = assist();
    const events = [
      { type: 'humanAttestation', inputType: null, data: null } as unknown as StoredEvent,
      { type: 'environmentProbe', data: { webdriver: null, automationGlobals: [], editorAssist: decl } } as unknown as StoredEvent,
    ];
    expect(getEditorAssistDeclaration(events)).toBe(decl);
  });

  it('returns null when no environmentProbe event is present', () => {
    const events = [{ type: 'contentChange', inputType: 'insertText', data: 'a' } as unknown as StoredEvent];
    expect(getEditorAssistDeclaration(events)).toBeNull();
  });
});

describe('isSuspiciousBulkInsert (#140: verifier/editor 単一定義)', () => {
  it('flags replaceContent / insertReplacementText / multi-char insertText', () => {
    expect(isSuspiciousBulkInsert(insert(')', 'replaceContent'))).toBe(true);
    expect(isSuspiciousBulkInsert(insert('foo', 'insertReplacementText'))).toBe(true);
    expect(isSuspiciousBulkInsert(insert('ab', 'insertText'))).toBe(true);
  });

  it('does not flag a single-char insertText', () => {
    expect(isSuspiciousBulkInsert(insert('a', 'insertText'))).toBe(false);
  });

  it('flags a rangeOffset-bearing internal paste that actually inserts content', () => {
    // #140 のドリフト源。editor がこれを出したとき申告と再計算が一致する必要がある。
    const ev = { type: 'contentChange', inputType: 'insertFromInternalPaste', data: 'pasted', rangeOffset: 5 } as unknown as StoredEvent;
    expect(isSuspiciousBulkInsert(ev)).toBe(true);
  });

  it('does not flag the internal-paste audit marker (rangeOffset == null)', () => {
    const marker = { type: 'contentChange', inputType: 'insertFromInternalPaste', data: 'pasted', rangeOffset: null } as unknown as StoredEvent;
    expect(isSuspiciousBulkInsert(marker)).toBe(false);
  });
});

describe('bulkInsertEvents parity: StatisticsCalculator (editor 申告) と isSuspiciousBulkInsert (verifier 再計算)', () => {
  // editor の申告 (StatisticsCalculator.bulkInsertEvents) と verifier の再計算が
  // 同じ定義から出ることを固定する。ズレると verifyProofMetadata の完全一致照合で
  // 正規 proof が invalid になる (#140)。
  it('StatisticsCalculator counts exactly the events isSuspiciousBulkInsert flags', () => {
    const events: StoredEvent[] = [
      insert('a', 'insertText'),                    // single char → not bulk
      insert('foo()', 'insertReplacementText'),     // completion → bulk
      insert(')', 'replaceContent'),                // type-over → bulk
      insert('xy', 'insertText'),                   // multi char → bulk
      { type: 'contentChange', inputType: 'insertFromInternalPaste', data: 'block', rangeOffset: 3 } as unknown as StoredEvent, // rangeOffset paste → bulk
      { type: 'contentChange', inputType: 'insertFromInternalPaste', data: 'block', rangeOffset: null } as unknown as StoredEvent, // marker → not bulk
    ];
    const expected = events.filter((e) => isSuspiciousBulkInsert(e)).length;
    const stats = new StatisticsCalculator().getTypingStatistics(events, 0);
    expect(stats.bulkInsertEvents).toBe(expected);
    expect(stats.bulkInsertEvents).toBe(4);
  });
});
