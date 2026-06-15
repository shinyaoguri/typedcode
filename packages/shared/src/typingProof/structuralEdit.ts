/**
 * エディタの整形挙動 (括弧/クォートの自動閉じ・type-over・auto-indent/dedent) 由来の
 * 「構造的編集」を識別する。
 *
 * 背景: Monaco で括弧を打つと、1 つの実キーストロークに対して editor が複数文字の
 * contentChange を生成する:
 *   - `(` → auto-closing が `()` を挿入 (`insertReplacementText`, 長さ 2)
 *   - 閉じ括弧を自動閉じの上から打つ → type-over (`replaceContent`, data=`)` 等)
 *   - `}` を字下げ行で打つ → auto-dedent (`replaceContent`, data=`}`・rangeLength>0)
 * これらは verifier の `isSuspiciousBulkInsert` に引っかかり、**全打鍵を自分で打った
 * 正規セッションでも `Pure Typing: NO` / 「外部入力あり」になる** 誤検知を生む。
 *
 * 本判定はこの誤検知を **advisory レイヤ (`isPureTyping` / 外部入力カウント) だけ** で
 * 打ち消す。除外条件は「挿入データが**括弧・クォート・空白のみ**で構成される editor 内部の
 * 挿入/置換」に限る。コードのペイロード (識別子・数値・演算子) は構造文字ではないので、
 * **ペーストした実コードを純粋打鍵に偽装する抜け穴にはならない** (置換で内容を消すことは
 * できても、コードを忍ばせることはできない)。
 *
 * `valid` (暗号的合否) にも `bulkInsertEvents` の申告メタデータ照合にも影響しない。
 * 既存 proof との後方互換も保たれる (照合は従来どおり全 bulk insert を数える)。
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
 * 与えられた contentChange が editor の整形挙動由来の「構造的編集」か
 * (挿入データが括弧/クォート/空白のみ)。
 */
export function isStructuralEditInsert(event: StoredEvent): boolean {
  if (event.type !== 'contentChange') return false;
  if (typeof event.inputType !== 'string' || !EDITOR_INTERNAL_INSERT.has(event.inputType)) {
    return false;
  }
  return typeof event.data === 'string' && event.data.length > 0 && STRUCTURAL_CHARS.test(event.data);
}
