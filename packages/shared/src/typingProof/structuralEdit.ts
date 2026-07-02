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
 *   - benign  = editor 内部の挿入/置換で「構造文字のみ」または「上限長以内の単一行」
 *               (単一行にも長さ上限を置く (#139)。minify した 1 行プログラムの laundering 対策)
 *   - bulk    = 改行＋実コードを含む複数行の挿入 (AI/スニペットの一括投入。記録・検出対象)
 *
 * いずれも `valid` (暗号的合否) や `bulkInsertEvents` の申告メタデータ照合には影響しない。
 * advisory な `isPureTyping` / 外部入力カウント / 分析シグナルの精度を上げるだけ。
 */

import type { StoredEvent, EditorAssistDeclaration } from '../types.js';

/** 構造文字: 括弧・クォート・空白。これらだけなら「内容 (コード)」を運べない。 */
const STRUCTURAL_CHARS = /^[()\[\]{}<>"'`\s]+$/;

/**
 * editor 内部由来の挿入/置換 inputType (実ペースト/ドロップは含めない)。
 * `insertParagraph` は Monaco が「複数行テキストの単一挿入」(auto-indent 展開・AI/snippet の
 * 一括投入・programmatic insertText) に付ける。空白のみなら benign、コードを含めば bulk。
 */
const EDITOR_INTERNAL_INSERT: ReadonlySet<string> = new Set([
  'insertText',
  'insertReplacementText',
  'replaceContent',
  'insertParagraph',
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
 * 単一行 benign (補完) とみなす最大文字数 (#139)。現実の補完は識別子〜1 式程度で、これで
 * 十分収まる。上限が無いと minify した 1 行のプログラム全体 (数千文字) を `insertText`
 * 1 イベントで投入しても isPureTyping を保ててしまう (laundering 口)。
 * 構造文字のみ (内容を運べない) の挿入には適用しない。
 */
export const MAX_BENIGN_SINGLE_LINE_INSERT_CHARS = 120;

/**
 * 「1 キー入力 → 複数文字」の正規な editor 挿入か (括弧自動閉じ・type-over・auto-indent・
 * 単一行の補完)。構造文字のみ、または上限長以内の単一行 (改行を含まない) の editor 内部挿入。
 * 上限を超える単一行挿入は補完として現実的でないため benign にしない (#139)。
 */
export function isBenignEditorInsert(event: StoredEvent): boolean {
  if (!isEditorInternalInsert(event)) return false;
  const data = event.data;
  if (typeof data !== 'string' || data.length === 0) return false;
  if (STRUCTURAL_CHARS.test(data)) return true; // 括弧/クォート/空白のみ (内容を運べない)
  return !/[\r\n]/.test(data) && data.length <= MAX_BENIGN_SINGLE_LINE_INSERT_CHARS; // 単一行 = 補完 (上限つき)
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

/**
 * 「疑わしい一括挿入」か (bulkInsertEvents メタデータのカウント対象)。
 *
 * verifier (`verification.ts` の再計算) と editor (`StatisticsCalculator` の申告) の
 * **単一の真実源**。過去に両者へ別実装で置かれ、verifier だけが `insertFromInternalPaste`
 * (rangeOffset 付き・実挿入) を数える分岐を持ってドリフトしていた (#140)。editor が
 * rangeOffset 付き内部ペーストを出し始めた瞬間、申告 < 再計算で `verifyProofMetadata` の
 * bulkInsertEvents 照合が失敗し、正規 proof が invalid になる時限バグだった。
 *
 * **この定義を変えると既存 proof の bulkInsertEvents 照合が壊れ後方互換を失う** (verifier の
 * 再計算値が変わるため)。変更時は proof フォーマット互換性を必ず検討すること。
 */
export function isSuspiciousBulkInsert(event: StoredEvent): boolean {
  if (event.type !== 'contentChange') return false;

  if (event.inputType === 'replaceContent' || event.inputType === 'insertReplacementText') {
    return true;
  }

  // 内容を実際に挿入する大きな insertFromInternalPaste は怪しい。手製 proof がバルク挿入を
  // 「内部ペースト」と偽装して isPureTyping 判定を回避するのを防ぐ (verifier は inputType ラベルを
  // 信用するしかないため)。editor が出す正規の内部ペースト監査イベントは rangeOffset==null で
  // verifyContentReplay 上スキップされる (内容を挿入しない) ので、ここには該当しない。
  if (
    event.inputType === 'insertFromInternalPaste' &&
    event.rangeOffset != null &&
    typeof event.data === 'string' &&
    event.data.length > 1
  ) {
    return true;
  }

  return (
    event.inputType === 'insertText' &&
    typeof event.data === 'string' &&
    event.data.length > 1
  );
}

/**
 * events から内部ペースト (自分のコードのコピペ = 許可) の挿入内容を集める。
 * 内部ペーストは `insertFromInternalPaste` の監査マーカー (rangeOffset==null) を伴い、
 * 実際の挿入は別途 contentChange (複数行なら insertParagraph) として記録される。後者を
 * AI 一括投入と取り違えないよう、監査マーカーと同一内容を許可リスト化する。
 */
export function collectInternalPasteContents(events: readonly StoredEvent[]): Set<string> {
  const out = new Set<string>();
  for (const event of events) {
    if (event?.inputType === 'insertFromInternalPaste' && typeof event.data === 'string') {
      out.add(event.data);
    }
  }
  return out;
}

/**
 * 複数行 bulk 挿入のうち「記録・検出すべきもの」か (内部ペーストの実挿入は除外する)。
 * `internalPasteContents` は collectInternalPasteContents の結果を渡す。
 */
export function isFlaggedBulkInsert(
  event: StoredEvent,
  internalPasteContents: ReadonlySet<string>,
): boolean {
  if (!isMultiLineBulkInsert(event)) return false;
  // 内部ペースト (自分のコード) の実挿入は許可。AI/外部の一括投入だけ残す。
  if (typeof event.data === 'string' && internalPasteContents.has(event.data)) return false;
  return true;
}
