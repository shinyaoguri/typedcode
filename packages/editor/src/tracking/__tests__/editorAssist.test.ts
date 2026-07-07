/**
 * editor-assist 宣言の正規化 (ADR-0019) のテスト。
 * buildEditorAssistDeclaration は Monaco 非依存の純関数なので実体を直接使う。
 */

import { describe, expect, it } from 'vitest';
import { buildEditorAssistDeclaration } from '../editorAssist.js';

describe('buildEditorAssistDeclaration', () => {
  it('declares schema editor-assist/1', () => {
    expect(buildEditorAssistDeclaration({}).schema).toBe('editor-assist/1');
  });

  it('records null for every option when nothing could be read (graceful absence)', () => {
    const d = buildEditorAssistDeclaration({});
    expect(d.quickSuggestions).toBeNull();
    expect(d.suggestOnTriggerCharacters).toBeNull();
    expect(d.wordBasedSuggestions).toBeNull();
    expect(d.snippetSuggestions).toBeNull();
    expect(d.inlineSuggest).toBeNull();
    expect(d.tabCompletion).toBeNull();
    expect(d.acceptSuggestionOnEnter).toBeNull();
    expect(d.parameterHints).toBeNull();
    expect(d.autoClosingBrackets).toBeNull();
    expect(d.autoClosingQuotes).toBeNull();
    expect(d.autoSurround).toBeNull();
    expect(d.formatOnType).toBeNull();
    expect(d.formatOnPaste).toBeNull();
  });

  it('records null for unknown-typed values instead of fabricating them', () => {
    const d = buildEditorAssistDeclaration({
      suggestOnTriggerCharacters: 42,
      wordBasedSuggestions: { weird: true },
      formatOnType: 'yes',
    });
    expect(d.suggestOnTriggerCharacters).toBeNull();
    expect(d.wordBasedSuggestions).toBeNull();
    expect(d.formatOnType).toBeNull();
  });

  it('normalizes a resolved quickSuggestions object to true when any channel is enabled', () => {
    const d = buildEditorAssistDeclaration({
      quickSuggestions: { other: 'on', comments: 'off', strings: 'off' },
    });
    expect(d.quickSuggestions).toBe(true);
  });

  it('treats inline-mode quickSuggestions channels as enabled', () => {
    const d = buildEditorAssistDeclaration({
      quickSuggestions: { other: 'inline', comments: 'off', strings: 'off' },
    });
    expect(d.quickSuggestions).toBe(true);
  });

  it('normalizes a quickSuggestions object to false when all channels are off', () => {
    const d = buildEditorAssistDeclaration({
      quickSuggestions: { other: 'off', comments: 'off', strings: 'off' },
    });
    expect(d.quickSuggestions).toBe(false);
  });

  it('accepts a plain boolean quickSuggestions value', () => {
    expect(buildEditorAssistDeclaration({ quickSuggestions: true }).quickSuggestions).toBe(true);
    expect(buildEditorAssistDeclaration({ quickSuggestions: false }).quickSuggestions).toBe(false);
  });

  it('passes through string enum values unchanged', () => {
    const d = buildEditorAssistDeclaration({
      wordBasedSuggestions: 'currentDocument',
      snippetSuggestions: 'inline',
      tabCompletion: 'onlySnippets',
      acceptSuggestionOnEnter: 'smart',
      autoClosingBrackets: 'languageDefined',
      autoClosingQuotes: 'beforeWhitespace',
      autoSurround: 'quotes',
    });
    expect(d.wordBasedSuggestions).toBe('currentDocument');
    expect(d.snippetSuggestions).toBe('inline');
    expect(d.tabCompletion).toBe('onlySnippets');
    expect(d.acceptSuggestionOnEnter).toBe('smart');
    expect(d.autoClosingBrackets).toBe('languageDefined');
    expect(d.autoClosingQuotes).toBe('beforeWhitespace');
    expect(d.autoSurround).toBe('quotes');
  });

  it('maps boolean-typed enum options to on/off strings for cross-version comparability', () => {
    const d = buildEditorAssistDeclaration({ wordBasedSuggestions: true, tabCompletion: false });
    expect(d.wordBasedSuggestions).toBe('on');
    expect(d.tabCompletion).toBe('off');
  });

  it('extracts the enabled flag from inlineSuggest and parameterHints option objects', () => {
    const d = buildEditorAssistDeclaration({
      inlineSuggest: { enabled: true, mode: 'subwordSmart' },
      parameterHints: { enabled: false, cycle: true },
    });
    expect(d.inlineSuggest).toBe(true);
    expect(d.parameterHints).toBe(false);
  });

  it('records boolean pass-through options verbatim', () => {
    const d = buildEditorAssistDeclaration({
      suggestOnTriggerCharacters: true,
      formatOnType: false,
      formatOnPaste: true,
    });
    expect(d.suggestOnTriggerCharacters).toBe(true);
    expect(d.formatOnType).toBe(false);
    expect(d.formatOnPaste).toBe(true);
  });
});
