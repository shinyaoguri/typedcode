/**
 * 教員用の一括検証の対象を、作問画面の索引の問題から集める (#799 / ADR-0051 Decision 6)。DOM に触れない。
 *
 * - 解答例: 問題定義の `solutions` の順。名前は根からの相対パス、ファイル名はその basename、言語は拡張子から
 *   (`starterLanguage.ts` の対応。C / C++ / Python 以外は実行器が `unsupported` にする)
 * - ケース: 問題定義の `cases` のケースファイルを `parseCasesDefinition` で読む (`match` を渡す)
 * - 内容は `source.readText` から読む。作問画面は「開いている文書の今のテキスト (未保存を含む)、開いていなければ
 *   フォルダ」を返す口 (`AuthorWorkspace.readCurrentText`) を渡す。直しながら回せるようにするため
 *
 * 実行できない (解答例が無い・ケースが無い・参照先が欠けている・読めない) ときは、何も走らせずに理由を返す。
 * 結果は proof にも教材フォルダにも記録しない。
 */

import type { IndexedProblem, ProblemPart } from '../workspace/authorWorkspace.js';
import { type DefinitionIssue, parseCasesDefinition } from '../workspace/definitions.js';
import { workspaceBasename } from '../workspace/paths.js';
import { extensionToLanguage } from '../starterLanguage.js';
import type { VerificationCase, VerificationSolution } from './runBatchVerification.js';

/** 対象を読む口 */
export interface VerificationSource {
  /** 根からの相対パスのファイルの今のテキスト */
  readText(path: string): Promise<string>;
}

/** 実行できない理由 */
export type VerificationBlockReason =
  /** 問題定義が読めない */
  | { readonly kind: 'problem-invalid'; readonly path: string }
  /** 解答例が 1 つも無い */
  | { readonly kind: 'no-solutions' }
  /** ケースファイルが設定されていない */
  | { readonly kind: 'no-cases' }
  /** 参照先のファイルが無い (参照が解決できない場合を含む。`path` は解決できなければ参照の綴り) */
  | { readonly kind: 'missing-file'; readonly path: string }
  /** ファイルを読めなかった */
  | { readonly kind: 'read-failed'; readonly path: string; readonly cause: unknown }
  /** ケースファイルを定義として読めない */
  | { readonly kind: 'cases-invalid'; readonly path: string; readonly issues: readonly DefinitionIssue[] }
  /** ケースファイルにケースが 1 つも無い */
  | { readonly kind: 'empty-cases'; readonly path: string };

export type VerificationTargets =
  | {
      readonly ok: true;
      readonly problemPath: string;
      readonly solutions: VerificationSolution[];
      readonly cases: VerificationCase[];
    }
  | { readonly ok: false; readonly problemPath: string; readonly reason: VerificationBlockReason };

function blocked(problemPath: string, reason: VerificationBlockReason): VerificationTargets {
  return { ok: false, problemPath, reason };
}

/** 参照先が在れば一覧の綴りのパス、無ければ null */
function existingPath(part: ProblemPart): string | null {
  return part.exists && part.path !== null ? part.path : null;
}

/** 問題の解答例とケースを集める */
export async function collectVerificationTargets(
  problem: IndexedProblem,
  source: VerificationSource
): Promise<VerificationTargets> {
  const problemPath = problem.path;
  if (problem.status !== 'ok') return blocked(problemPath, { kind: 'problem-invalid', path: problemPath });

  const solutionParts = problem.parts.filter((part) => part.role === 'solution');
  const casesPart = problem.parts.find((part) => part.role === 'cases');
  if (solutionParts.length === 0) return blocked(problemPath, { kind: 'no-solutions' });
  if (!casesPart) return blocked(problemPath, { kind: 'no-cases' });
  for (const part of [...solutionParts, casesPart]) {
    if (existingPath(part) === null)
      return blocked(problemPath, { kind: 'missing-file', path: part.path ?? part.reference });
  }

  const solutions: VerificationSolution[] = [];
  for (const part of solutionParts) {
    const path = existingPath(part)!;
    let code: string;
    try {
      code = await source.readText(path);
    } catch (cause) {
      return blocked(problemPath, { kind: 'read-failed', path, cause });
    }
    const filename = workspaceBasename(path);
    solutions.push({ name: path, language: extensionToLanguage(filename), filename, code });
  }

  const casesPath = existingPath(casesPart)!;
  let casesText: string;
  try {
    casesText = await source.readText(casesPath);
  } catch (cause) {
    return blocked(problemPath, { kind: 'read-failed', path: casesPath, cause });
  }
  const parsed = parseCasesDefinition(casesText);
  if (!parsed.ok) return blocked(problemPath, { kind: 'cases-invalid', path: casesPath, issues: parsed.issues });
  if (parsed.value.length === 0) return blocked(problemPath, { kind: 'empty-cases', path: casesPath });
  const cases: VerificationCase[] = parsed.value.map((item) => ({
    name: item.name,
    stdin: item.stdin,
    stdout: item.stdout,
    match: item.match,
  }));
  return { ok: true, problemPath, solutions, cases };
}
