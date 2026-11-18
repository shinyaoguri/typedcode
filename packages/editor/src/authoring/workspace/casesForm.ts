/**
 * ケースファイル (`*.cases.yaml`) のフォームの状態 (#798 / ADR-0051、system-spec §4.10)。DOM に触れない。
 *
 * - **操作**: 今のテキストに操作 (追加・複製・削除・欄の変更) を当てた新しいテキストを返す。書き戻しは
 *   `updateCasesDefinitionText` (変えた欄だけを差し替え、コメントと未知のキーを残す)。フォームの操作は文書の編集として
 *   扱うので、ここはファイルに書かない (保存・競合は他の文書と同じ経路)
 * - **触っていない値は 1 文字も変えない**: 操作が名指しした欄以外は、今のテキストを読んだ値をそのまま渡す。
 *   途中のケースを消す・足すときも、残るケースは元の節点 (コメントごと) から作る (`sources`)
 * - 名前が空・重複になる操作はテキストを作らずに理由を返す (打っている途中の名前で文書を壊さない)
 * - 既定の名前・複製の名前の語は画面 (i18n) が渡す
 */

import {
  type CaseDefinition,
  type CaseMatch,
  type DefinitionIssue,
  parseCasesDefinition,
  updateCasesDefinitionText,
} from './definitions.js';

/** 欄の変更で書き換えられる値 (`name`・`stdin`・`stdout`・`public`・`match`) */
export type CaseFieldPatch = Partial<CaseDefinition>;

/** フォームの操作 1 つ。`index` はケースの並び (0 始まり) の位置。 */
export type CasesFormOp =
  /** 末尾に空の入出力のケースを足す */
  | { readonly kind: 'add'; readonly name: string }
  /** `index` のケースの写しを直後に入れる (値・`public`・`match` は元と同じ) */
  | { readonly kind: 'duplicate'; readonly index: number; readonly name: string }
  | { readonly kind: 'remove'; readonly index: number }
  /** `index` のケースの、`patch` に挙げた欄だけを変える */
  | { readonly kind: 'edit'; readonly index: number; readonly patch: CaseFieldPatch };

/** 操作を当てられなかった理由。 */
export type CasesFormError =
  /** 今のテキスト、または当てた結果がケースファイルとして読めない */
  | { readonly kind: 'invalid-definition'; readonly issues: readonly DefinitionIssue[] }
  /** 位置がケースの並びの外 */
  | { readonly kind: 'out-of-range'; readonly index: number }
  /** 名前が空 (空白だけを含む) */
  | { readonly kind: 'empty-name' }
  /** 名前が別のケースと重なる */
  | { readonly kind: 'duplicate-name'; readonly name: string };

export type CasesFormResult =
  | {
      readonly ok: true;
      readonly text: string;
      /** 操作の後に選ぶケースの位置 (足した・写したケース、消した位置の隣)。ケースが無ければ -1 */
      readonly selected: number;
    }
  | { readonly ok: false; readonly error: CasesFormError };

/** ケースの名前として使えるか (空・重複でない)。`except` の位置のケースとは比べない (自分自身の改名)。 */
export function checkCaseName(cases: readonly CaseDefinition[], name: string, except?: number): CasesFormError | null {
  // 空の判定は parseCasesDefinition (非空の文字列 = trim して空でない) に合わせる
  if (name.trim() === '') return { kind: 'empty-name' };
  if (cases.some((c, i) => i !== except && c.name === name)) return { kind: 'duplicate-name', name };
  return null;
}

/** 足すケースの既定の名前。`format(n)` の n を 件数 + 1 から始め、既存と重ならない最初のものにする。 */
export function nextCaseName(cases: readonly CaseDefinition[], format: (n: number) => string): string {
  const names = new Set(cases.map((c) => c.name));
  let n = cases.length + 1;
  while (names.has(format(n))) n += 1;
  return format(n);
}

/** 写しの名前。`format(元の名前, n)` の n を 2 から始め、既存と重ならない最初のものにする。 */
export function duplicateCaseName(
  cases: readonly CaseDefinition[],
  original: string,
  format: (base: string, n: number) => string
): string {
  const names = new Set(cases.map((c) => c.name));
  let n = 2;
  while (names.has(format(original, n))) n += 1;
  return format(original, n);
}

/** ケースファイルのテキストにフォームの操作を当てた新しいテキストを返す。変化が無ければ元のテキストをそのまま返す。 */
export function applyCasesFormOp(text: string, op: CasesFormOp): CasesFormResult {
  const current = parseCasesDefinition(text);
  if (!current.ok) return { ok: false, error: { kind: 'invalid-definition', issues: current.issues } };
  const cases = current.value;
  const identity = cases.map((_, i): number | null => i);
  let next: CaseDefinition[];
  let sources: (number | null)[];
  let selected: number;
  switch (op.kind) {
    case 'add': {
      const error = checkCaseName(cases, op.name);
      if (error) return { ok: false, error };
      next = [...cases, { name: op.name, stdin: '', stdout: '', public: false, match: 'trim' }];
      sources = [...identity, null];
      selected = cases.length;
      break;
    }
    case 'duplicate': {
      if (!inRange(cases, op.index)) return outOfRange(op.index);
      const error = checkCaseName(cases, op.name);
      if (error) return { ok: false, error };
      next = [...cases];
      next.splice(op.index + 1, 0, { ...cases[op.index]!, name: op.name });
      sources = [...identity];
      sources.splice(op.index + 1, 0, null);
      selected = op.index + 1;
      break;
    }
    case 'remove': {
      if (!inRange(cases, op.index)) return outOfRange(op.index);
      next = cases.filter((_, i) => i !== op.index);
      sources = identity.filter((_, i) => i !== op.index);
      selected = Math.min(op.index, next.length - 1);
      break;
    }
    case 'edit': {
      if (!inRange(cases, op.index)) return outOfRange(op.index);
      if (op.patch.name !== undefined) {
        const error = checkCaseName(cases, op.patch.name, op.index);
        if (error) return { ok: false, error };
      }
      // 名指しした欄だけを変える (undefined の欄は元の値のまま)
      const edited: CaseDefinition = { ...cases[op.index]! };
      for (const key of ['name', 'stdin', 'stdout', 'public', 'match'] as const) {
        const value = op.patch[key];
        if (value !== undefined) (edited as unknown as Record<string, unknown>)[key] = value;
      }
      next = cases.map((c, i) => (i === op.index ? edited : c));
      sources = identity;
      selected = op.index;
      break;
    }
  }
  const updated = updateCasesDefinitionText(text, next, sources);
  if (!updated.ok) return { ok: false, error: { kind: 'invalid-definition', issues: updated.issues } };
  return { ok: true, text: updated.text, selected };
}

function inRange(cases: readonly CaseDefinition[], index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < cases.length;
}

function outOfRange(index: number): CasesFormResult {
  return { ok: false, error: { kind: 'out-of-range', index } };
}

/**
 * 値の末尾の改行の個数。`\r\n` は 1 個の改行として数える (単独の `\r` も 1 個)。
 * 例: `''` → 0、`'a'` → 0、`'a\n'` → 1、`'a\n\n'` → 2、`'a\r\n'` → 1
 */
export function countTrailingNewlines(value: string): number {
  let count = 0;
  let end = value.length;
  while (end > 0) {
    if (value[end - 1] === '\n') {
      end -= end > 1 && value[end - 2] === '\r' ? 2 : 1;
    } else if (value[end - 1] === '\r') {
      end -= 1;
    } else {
      break;
    }
    count += 1;
  }
  return count;
}

/** 値が `\r` (CRLF を含む) を持つか。テキストエリアで編集すると改行が LF にそろう値。 */
export function containsCarriageReturn(value: string): boolean {
  return value.includes('\r');
}

/** 照合の方法の並び (選択肢の順) */
export const CASE_MATCH_OPTIONS: readonly CaseMatch[] = ['trim', 'exact'];
