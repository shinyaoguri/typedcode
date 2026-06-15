import { describe, it, expect } from 'vitest';
import { getEditorAssistDeclaration, isStructuralEditInsert } from '../structuralEdit.js';
import type { StoredEvent, EditorAssistDeclaration } from '../../types.js';

function insert(data: unknown, inputType: string, rangeLength = 0): StoredEvent {
  return { type: 'contentChange', inputType, data, rangeLength } as unknown as StoredEvent;
}

describe('isStructuralEditInsert', () => {
  it('discounts an auto-closed bracket pair (insertReplacementText "()")', () => {
    expect(isStructuralEditInsert(insert('()', 'insertReplacementText'))).toBe(true);
  });

  it('discounts an auto-closed quote pair (insertReplacementText \'""\')', () => {
    expect(isStructuralEditInsert(insert('""', 'insertReplacementText'))).toBe(true);
  });

  it('discounts a type-over of a single closing bracket (replaceContent ")")', () => {
    expect(isStructuralEditInsert(insert(')', 'replaceContent', 1))).toBe(true);
  });

  it('discounts an auto-dedent that re-inserts a single brace (replaceContent "}")', () => {
    expect(isStructuralEditInsert(insert('}', 'replaceContent', 6))).toBe(true);
  });

  it('discounts whitespace-only structural inserts', () => {
    expect(isStructuralEditInsert(insert('\r\n    ', 'insertText'))).toBe(true);
  });

  it('does NOT discount an insert that contains code (identifier)', () => {
    expect(isStructuralEditInsert(insert('foo()', 'insertReplacementText'))).toBe(false);
  });

  it('does NOT discount a real paste even of pure brackets (paste is not editor-internal)', () => {
    expect(isStructuralEditInsert(insert('()', 'insertFromPaste'))).toBe(false);
  });

  it('does NOT discount an internal paste (handled as its own allowed type)', () => {
    expect(isStructuralEditInsert(insert('()', 'insertFromInternalPaste'))).toBe(false);
  });

  it('does NOT discount an empty insert', () => {
    expect(isStructuralEditInsert(insert('', 'insertText'))).toBe(false);
  });

  it('does NOT discount non-contentChange events', () => {
    expect(isStructuralEditInsert({ type: 'keyDown', inputType: null, data: null } as unknown as StoredEvent)).toBe(false);
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
