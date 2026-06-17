import { describe, it, expect } from 'vitest';
import {
  getEditorAssistDeclaration,
  isBenignEditorInsert,
  isMultiLineBulkInsert,
  isFlaggedBulkInsert,
  collectInternalPasteContents,
} from '../structuralEdit.js';
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

  it('flags an AI/external multi-line block when no internal-paste audit matches', () => {
    expect(isFlaggedBulkInsert(insert(code, 'insertParagraph'), new Set())).toBe(true);
  });

  it('does NOT flag a multi-line insert whose content matches an internal-paste audit', () => {
    const internal = new Set([code]);
    expect(isFlaggedBulkInsert(insert(code, 'insertParagraph'), internal)).toBe(false);
  });

  it('collectInternalPasteContents gathers insertFromInternalPaste data', () => {
    const events = [
      insert('a', 'insertText'),
      insert(code, 'insertFromInternalPaste'),
    ];
    const set = collectInternalPasteContents(events as never);
    expect(set.has(code)).toBe(true);
    expect(set.size).toBe(1);
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
