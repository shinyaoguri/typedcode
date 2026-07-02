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
import { applyReplayEventTolerant, isDivergentContentSnapshot } from './replay.js';

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
   * 適用済みイベントまでの replay 文書 (読み取り専用)。
   * 呼び出し側が `checkAndApply` の**前**に snapshot 乖離判定 (#175) へ渡すために公開する。
   */
  get currentContent(): string {
    return this.content;
  }

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

    // #175: 乖離した contentSnapshot は台帳に取り込まない。取り込むと持ち込んだ内容の
    // 部分文字列が以後「セッション由来」と誤認され、内部ペースト検証の迂回路になる。
    // 正規 snapshot は replay と常に一致する no-op なので、この分岐は正直な proof に影響しない。
    if (isDivergentContentSnapshot(event, this.content)) {
      return false;
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
