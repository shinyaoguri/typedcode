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
import { applyReplayEventTolerant } from './replay.js';

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

/**
 * セッション内在性 (session provenance) の逐次台帳 (#138)。
 *
 * 内部ペースト (自分のコードのコピペ = 許可) の実挿入を AI 一括投入と区別するために使う。
 * 従来は `insertFromInternalPaste` の監査マーカーの data を**無条件に**許可リスト化していた
 * ため、手製 proof で「マーカー(data=AI コード) + insertParagraph(同一 data)」のペアを
 * 作るだけで isPureTyping を保てる laundering 口だった (#138)。マーカーは自己申告であり、
 * 判定の入力にしない (ADR-0020)。
 *
 * 代わりに、editor 側 `SessionContentRegistry` の判定 (コピー登録 or 現文書の部分文字列)
 * を verifier 側で replay により再現する。events を記録順に 1 度ずつ `checkAndApply` へ
 * 通すと、イベント適用**前**の状態に対して「このイベントの内容はセッション由来か」を返す:
 *   (a) それ以前の `copyOperation` の data と完全一致し、かつその data がコピー時点の
 *       replay 文書の部分文字列だった (捏造 copyOperation ごと持ち込む偽装も塞ぐ)。
 *       コピー済み内容は編集で消えても有効 (editor の copiedContent と同じ)
 *   (b) 適用前の replay 文書の部分文字列である
 * 「適用前」が重要 — 事前パスの許可リスト方式だと「実挿入 → マーカー」と並べ替えるだけで
 * 挿入後の文書を根拠に自己検証できてしまう。
 *
 * 限界: 別タブからのコピペは正規でもこの proof (= 1 タブ) 内では検証できず、bulk 扱いに
 * なる (advisory の isPureTyping が崩れるだけで valid は不変)。タブ横断の突合は ZIP 全体を
 * 見る呼び出し側の将来課題。
 */
export class SessionProvenanceLedger {
  private content = '';
  private verifiedCopies = new Set<string>();

  /**
   * イベントを 1 つ進める。返り値は「このイベントの data がセッション由来か」
   * (適用前の文書 or 検証済みコピーに対する判定)。events の記録順に全イベントを通すこと。
   */
  checkAndApply(event: StoredEvent): boolean {
    const data = typeof event.data === 'string' ? event.data : null;
    const sessionDerived =
      data !== null &&
      data.length > 0 &&
      (this.verifiedCopies.has(data) || this.content.includes(data));

    if (event.type === 'copyOperation') {
      // コピー内容が当時の文書に実在したときだけ「セッション由来」と認める。
      if (sessionDerived && data !== null) this.verifiedCopies.add(data);
      return sessionDerived;
    }

    this.content = applyReplayEventTolerant(this.content, event);
    return sessionDerived;
  }
}

/**
 * 複数行 bulk 挿入のうち「記録・検出すべきもの」か (内部ペーストの実挿入は除外する)。
 * `sessionDerived` は `SessionProvenanceLedger.checkAndApply` が当該イベントに返した値
 * (#138: マーカー由来の許可リストではなく、replay で検証したセッション内在性)。
 */
export function isFlaggedBulkInsert(event: StoredEvent, sessionDerived: boolean): boolean {
  if (!isMultiLineBulkInsert(event)) return false;
  // 内部ペースト (自分のコード) の実挿入は許可。AI/外部の一括投入だけ残す。
  return !sessionDerived;
}
