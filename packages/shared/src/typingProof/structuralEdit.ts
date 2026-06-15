/**
 * editor の整形挙動が生む複数文字の contentChange を分類する。
 *
 * Monaco では 1 つの実キーストロークに対して editor が複数文字を挿入することがある:
 *   - `(` → auto-closing が `()` を挿入 (`insertReplacementText`, 長さ 2)
 *   - 閉じ括弧を自動閉じの上から打つ → type-over (`replaceContent`, data=`)`)
 *   - `}` を字下げ行で打つ → auto-dedent (`replaceContent`, data=`}`・rangeLength>0)
 *   - 識別子の Tab/IntelliSense 補完 → 単一行の複数文字挿入 (`insertReplacementText`)
 * これらは「1 キー入力 → 複数文字」の **正規な入力** であり、Pure Typing を崩すべきではない。
 *
 * 一方、GitHub Copilot / Cursor のような **AI がコード全体を生成して Tab で一気に投入** する
 * ケースは記録し後から検出できるようにしたい。これは **複数行のコード塊** として現れる。
 * TypedCode 自身はインライン AI 補完を無効化している前提だが、万一混入しても捕捉する。
 *
 * 区別の基準は **複数行かどうか** (ユーザ確認済み):
 *   - benign  = editor 内部の挿入/置換で「構造文字のみ」または「単一行」
 *   - bulk    = 改行＋実コードを含む複数行の挿入 (AI/スニペットの一括投入。記録・検出対象)
 *
 * いずれも `valid` (暗号的合否) や `bulkInsertEvents` の申告メタデータ照合には影響しない。
 * advisory な `isPureTyping` / 外部入力カウント / 分析シグナルの精度を上げるだけ。
 */

import type { StoredEvent, EditorAssistDeclaration } from '../types.js';

/** 構造文字: 括弧・クォート・空白。これらだけなら「内容 (コード)」を運べない。 */
const STRUCTURAL_CHARS = /^[()\[\]{}<>"'`\s]+$/;

/** editor 内部由来の挿入/置換 inputType (実ペースト/ドロップは含めない)。 */
const EDITOR_INTERNAL_INSERT: ReadonlySet<string> = new Set([
  'insertText',
  'insertReplacementText',
  'replaceContent',
]);

function isEditorInternalInsert(event: StoredEvent): boolean {
  return (
    event.type === 'contentChange' &&
    typeof event.inputType === 'string' &&
    EDITOR_INTERNAL_INSERT.has(event.inputType)
  );
}

/**
 * events の起動時 `environmentProbe` から editorAssist 宣言を取り出す (無ければ null)。
 * editorAssist は proof の独立フィールドではなく environmentProbe イベント内にある (ADR-0019)。
 * 現状の判定では使わないが、宣言を参照したい将来の分析器のために公開しておく。
 */
export function getEditorAssistDeclaration(
  events: readonly StoredEvent[],
): EditorAssistDeclaration | null {
  for (const event of events) {
    if (event?.type === 'environmentProbe') {
      const data = event.data;
      if (data && typeof data === 'object' && 'editorAssist' in data) {
        return (data as { editorAssist?: EditorAssistDeclaration | null }).editorAssist ?? null;
      }
    }
  }
  return null;
}

/**
 * 「1 キー入力 → 複数文字」の正規な editor 挿入か (括弧自動閉じ・type-over・auto-indent・
 * 単一行の補完)。構造文字のみ、または単一行 (改行を含まない) の editor 内部挿入。
 */
export function isBenignEditorInsert(event: StoredEvent): boolean {
  if (!isEditorInternalInsert(event)) return false;
  const data = event.data;
  if (typeof data !== 'string' || data.length === 0) return false;
  if (STRUCTURAL_CHARS.test(data)) return true; // 括弧/クォート/空白のみ (内容を運べない)
  return !/[\r\n]/.test(data); // 単一行 = 補完
}

/**
 * AI/スニペットによる **複数行のコード一括投入** か (改行＋実コードを含む editor 内部挿入)。
 * 記録・検出対象。空白のみの複数行 (auto-indent) は対象外 (benign)。
 */
export function isMultiLineBulkInsert(event: StoredEvent): boolean {
  if (!isEditorInternalInsert(event)) return false;
  const data = event.data;
  if (typeof data !== 'string') return false;
  return /[\r\n]/.test(data) && /\S/.test(data);
}
