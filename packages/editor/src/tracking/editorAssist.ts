/**
 * editor-assist 宣言の構築 (ADR-0019)
 *
 * Monaco の解決済みオプション値を `EditorAssistDeclaration` に正規化する。
 * Monaco 本体には依存しない純関数 (node 環境でテスト可能)。Monaco からの
 * 値の読み出し (`editor.getOptions().get(EditorOption.X)`) は main.ts 側が行い、
 * 本モジュールは「読めた値を事実として正規化する」ことだけに責務を限定する。
 *
 * 正規化の規約 (graceful absence, ADR-0007):
 * - 取得できなかった値・未知の型の値は捏造せず null にする
 * - Monaco のバージョン差 (boolean ⇔ enum 文字列 ⇔ options オブジェクト) を吸収する
 */

import type { EditorAssistDeclaration } from '@typedcode/shared';

/**
 * Monaco から読み出した解決済みオプションの生値。
 * 値の型は Monaco バージョンに依存するため unknown で受ける。
 */
export interface RawAssistOptionValues {
  quickSuggestions: unknown;
  suggestOnTriggerCharacters: unknown;
  wordBasedSuggestions: unknown;
  snippetSuggestions: unknown;
  inlineSuggest: unknown;
  tabCompletion: unknown;
  acceptSuggestionOnEnter: unknown;
  parameterHints: unknown;
  autoClosingBrackets: unknown;
  autoClosingQuotes: unknown;
  autoSurround: unknown;
  formatOnType: unknown;
  formatOnPaste: unknown;
}

/** boolean ならそのまま、それ以外は null。 */
function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** 文字列 enum ならそのまま、boolean は 'on'/'off' に写像、それ以外は null。 */
function asEnumString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return null;
}

/** `{ enabled: boolean }` 形のオプション (inlineSuggest / parameterHints)。 */
function asEnabledFlag(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'object' && value !== null && 'enabled' in value) {
    return asBoolean((value as { enabled: unknown }).enabled);
  }
  return null;
}

/**
 * quickSuggestions の正規化。
 * 解決済み値は `{ other, comments, strings }` (各 'on' | 'inline' | 'off' | boolean)。
 * いずれか 1 つでも有効なら「候補表示あり」として true。
 */
function asQuickSuggestions(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'object' && value !== null) {
    const parts = Object.values(value as Record<string, unknown>);
    if (parts.length === 0) return null;
    return parts.some((p) => p === true || p === 'on' || p === 'inline');
  }
  return null;
}

/**
 * 解決済みオプションの生値から editor-assist 宣言を構築する。
 */
export function buildEditorAssistDeclaration(raw: Partial<RawAssistOptionValues>): EditorAssistDeclaration {
  return {
    schema: 'editor-assist/1',
    quickSuggestions: asQuickSuggestions(raw.quickSuggestions),
    suggestOnTriggerCharacters: asBoolean(raw.suggestOnTriggerCharacters),
    wordBasedSuggestions: asEnumString(raw.wordBasedSuggestions),
    snippetSuggestions: asEnumString(raw.snippetSuggestions),
    inlineSuggest: asEnabledFlag(raw.inlineSuggest),
    tabCompletion: asEnumString(raw.tabCompletion),
    acceptSuggestionOnEnter: asEnumString(raw.acceptSuggestionOnEnter),
    parameterHints: asEnabledFlag(raw.parameterHints),
    autoClosingBrackets: asEnumString(raw.autoClosingBrackets),
    autoClosingQuotes: asEnumString(raw.autoClosingQuotes),
    autoSurround: asEnumString(raw.autoSurround),
    formatOnType: asBoolean(raw.formatOnType),
    formatOnPaste: asBoolean(raw.formatOnPaste),
  };
}
