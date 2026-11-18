/**
 * 試験定義 (`*.exam.yaml`) のフォームの状態 (#797 / ADR-0051、system-spec §4.10)。DOM に触れない。
 *
 * - **操作**: 今のテキストに操作 (examId・種類・許可言語の変更、問題の採用・外す・並べ替え) を当てた新しいテキストを返す。
 *   書き戻しは `updateExamDefinitionText` (変えたキーだけを差し替え、コメントと未知のキーを残す)。フォームの操作は
 *   文書の編集として扱うので、ここはファイルに書かない (保存・競合は他の文書と同じ経路)
 * - **一覧**: 採用した問題 (出題順) と、まだ採用していない問題。採用した参照の先が無い・読めないものは消さずに
 *   欠損として一覧に残す (黙って除外しない)
 *
 * 問題の参照は試験定義から見た相対パス (`relativeWorkspaceReference`) で書く。同じ問題を 2 回採用しない
 * (照合は解決した根からのパスを NFC にそろえて行う)。
 */

import {
  type DefinitionIssue,
  type ExamDefinition,
  type ExamDefinitionPatch,
  type ExamKind,
  parseExamDefinition,
  updateExamDefinitionText,
} from './definitions.js';
import type { IndexedProblem, WorkspaceIndex } from './authorWorkspace.js';
import { relativeWorkspaceReference, type ReferenceRejection, resolveWorkspaceReference } from './paths.js';

/** フォームの操作 1 つ。`index` / `from` / `to` は採用した問題の並び (0 始まり) の位置。 */
export type ExamFormOp =
  | { readonly kind: 'set-exam-id'; readonly examId: string }
  | { readonly kind: 'set-kind'; readonly examKind: ExamKind }
  | { readonly kind: 'set-languages'; readonly languages: readonly string[] }
  /** 問題定義 (根からの相対パス) を末尾に採用する */
  | { readonly kind: 'adopt'; readonly problemPath: string }
  | { readonly kind: 'remove'; readonly index: number }
  | { readonly kind: 'move'; readonly from: number; readonly to: number };

/** 操作を当てられなかった理由。 */
export type ExamFormError =
  /** 今のテキスト、または当てた結果が試験定義として読めない (空の examId など) */
  | { readonly kind: 'invalid-definition'; readonly issues: readonly DefinitionIssue[] }
  /** その問題は既に採用している */
  | { readonly kind: 'already-adopted'; readonly problemPath: string }
  /** 位置が採用した問題の並びの外 */
  | { readonly kind: 'out-of-range'; readonly index: number };

export type ExamFormResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: ExamFormError };

function nfc(path: string): string {
  return path.normalize('NFC');
}

/** 許可言語の入力 (カンマ区切り) を言語の並びにする。空白を除き、空の要素と重複を落とす。 */
export function parseLanguageList(input: string): string[] {
  const out: string[] = [];
  for (const item of input.split(',')) {
    const language = item.trim();
    if (language !== '' && !out.includes(language)) out.push(language);
  }
  return out;
}

/** 試験定義のテキストにフォームの操作を当てた新しいテキストを返す。変化が無ければ元のテキストをそのまま返す。 */
export function applyExamFormOp(examPath: string, text: string, op: ExamFormOp): ExamFormResult {
  const current = parseExamDefinition(text);
  if (!current.ok) return { ok: false, error: { kind: 'invalid-definition', issues: current.issues } };
  const exam = current.value;
  let patch: ExamDefinitionPatch;
  switch (op.kind) {
    case 'set-exam-id':
      patch = { examId: op.examId };
      break;
    case 'set-kind':
      patch = { kind: op.examKind };
      break;
    case 'set-languages':
      patch = { languages: [...op.languages] };
      break;
    case 'adopt': {
      const target = nfc(op.problemPath);
      const adopted = exam.problems.some((reference) => {
        const resolved = resolveWorkspaceReference(examPath, reference);
        return resolved.ok && nfc(resolved.path) === target;
      });
      if (adopted) return { ok: false, error: { kind: 'already-adopted', problemPath: op.problemPath } };
      patch = { problems: [...exam.problems, relativeWorkspaceReference(examPath, op.problemPath)] };
      break;
    }
    case 'remove': {
      if (!inRange(exam, op.index)) return outOfRange(op.index);
      patch = { problems: exam.problems.filter((_, i) => i !== op.index) };
      break;
    }
    case 'move': {
      if (!inRange(exam, op.from)) return outOfRange(op.from);
      if (!inRange(exam, op.to)) return outOfRange(op.to);
      const problems = [...exam.problems];
      const [moved] = problems.splice(op.from, 1);
      problems.splice(op.to, 0, moved!);
      patch = { problems };
      break;
    }
  }
  const updated = updateExamDefinitionText(text, patch);
  if (!updated.ok) return { ok: false, error: { kind: 'invalid-definition', issues: updated.issues } };
  return { ok: true, text: updated.text };
}

function inRange(exam: ExamDefinition, index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < exam.problems.length;
}

function outOfRange(index: number): ExamFormResult {
  return { ok: false, error: { kind: 'out-of-range', index } };
}

/** 採用した問題 1 つの状態。 */
export type AdoptedProblemState =
  /** 問題定義が読めた */
  | 'ok'
  /** 参照の先に問題定義が無い (参照が解決できない場合を含む) */
  | 'missing'
  /** 問題定義はあるが読めない形 */
  | 'invalid';

export interface AdoptedProblem {
  /** 採用した並びの位置 (0 始まり) */
  readonly index: number;
  /** 試験定義に書かれたままの参照 */
  readonly reference: string;
  /** 根からの相対パス (在れば一覧の綴り)。参照が解決できなければ null */
  readonly path: string | null;
  readonly state: AdoptedProblemState;
  /** 参照を解決できなかった理由 (`path` が null のとき) */
  readonly rejection?: ReferenceRejection;
  /** 表示名 (問題定義の `title`、無ければ `id`)。読めないときは null */
  readonly label: string | null;
  /** 同じ問題を前の行でも採用している (手で書いた定義で起こりうる) */
  readonly duplicate: boolean;
}

export interface AvailableProblem {
  /** 問題定義のパス (一覧の綴り) */
  readonly path: string;
  readonly label: string;
}

export interface ExamFormModel {
  readonly exam: ExamDefinition;
  readonly adopted: readonly AdoptedProblem[];
  /** 採用できる問題 (読める問題定義のうち未採用のもの。索引の順) */
  readonly available: readonly AvailableProblem[];
}

function labelOf(problem: Extract<IndexedProblem, { status: 'ok' }>): string {
  return problem.definition.title ?? problem.definition.id;
}

/** 試験定義と索引から、フォームに出す一覧を作る。 */
export function examFormModel(examPath: string, exam: ExamDefinition, index: WorkspaceIndex): ExamFormModel {
  const problems = new Map(index.problems.map((problem) => [nfc(problem.path), problem] as const));
  const seen = new Set<string>();
  const adopted = exam.problems.map((reference, i): AdoptedProblem => {
    const resolved = resolveWorkspaceReference(examPath, reference);
    if (!resolved.ok) {
      return {
        index: i,
        reference,
        path: null,
        state: 'missing',
        rejection: resolved.reason,
        label: null,
        duplicate: false,
      };
    }
    const key = nfc(resolved.path);
    const duplicate = seen.has(key);
    seen.add(key);
    const problem = problems.get(key);
    if (!problem) return { index: i, reference, path: resolved.path, state: 'missing', label: null, duplicate };
    if (problem.status !== 'ok')
      return { index: i, reference, path: problem.path, state: 'invalid', label: null, duplicate };
    return { index: i, reference, path: problem.path, state: 'ok', label: labelOf(problem), duplicate };
  });
  const available = index.problems.flatMap((problem): AvailableProblem[] =>
    problem.status === 'ok' && !seen.has(nfc(problem.path)) ? [{ path: problem.path, label: labelOf(problem) }] : []
  );
  return { exam, adopted, available };
}
