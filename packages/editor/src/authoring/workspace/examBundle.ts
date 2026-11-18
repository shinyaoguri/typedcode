/**
 * 教材フォルダ → 配布物の問題列 (`ExamBundleProblem[]`) への変換 (ADR-0051 D4 / system-spec §4.10 の写像表)。
 *
 * - `problemId` = 問題定義の `id`、`statement` = 問題文の内容、`starter` = 初期コード
 *   (`filename` は basename、`language` は拡張子から)、`examples` = `public: true` のケースの `{ name, stdin, stdout }`
 * - `title`・ヒント・解答例・非公開ケース・`match` は配らない。ヒントと解答例は中身を読みに行かないが、
 *   ファイルがあるかは確かめる (採用問題が参照するファイルが 1 つでも欠けたら書き出さない)
 * - 欠損・誤りは最初の 1 件で止めずに全部集め、1 件でもあれば問題列を返さない (黙って除外しない)
 *
 * 配布物の生成器 (`createExamBundlePackage` / `buildClassPackage`) はこの結果をそのまま受ける。
 */

import type { ExamBundleProblem, ProblemExample } from '@typedcode/shared';
import { extensionToLanguage } from '../starterLanguage.js';
import {
  type DefinitionIssue,
  type ExamDefinition,
  type ParseResult,
  parseCasesDefinition,
  parseExamDefinition,
  parseProblemDefinition,
} from './definitions.js';
import { type ReferenceRejection, resolveWorkspaceReference, workspaceBasename } from './paths.js';
import type { WorkspaceReader } from './reader.js';

/**
 * 変換できない理由。`problem` はその理由が属する問題定義のパス (試験定義そのものの理由なら null)。
 * パスはどれも教材フォルダの根からの相対パス。
 */
export type WorkspaceIssue =
  /** 参照先のファイルが無い */
  | { kind: 'missing-file'; problem: string | null; path: string }
  /** 参照が絶対パス・フォルダの外などで解決できない。`source` は参照を書いた定義ファイル */
  | { kind: 'invalid-reference'; problem: string | null; source: string; reference: string; reason: ReferenceRejection }
  /** 定義ファイル (試験・問題・ケース) の中身が読めない形 */
  | { kind: 'invalid-definition'; problem: string | null; path: string; issues: DefinitionIssue[] }
  /** あるはずのファイルを読み出せない */
  | { kind: 'unreadable-file'; problem: string | null; path: string; message: string }
  /** 試験内で問題の `id` が重なる (`problems` は重なった問題定義のパス、出題順) */
  | { kind: 'duplicate-problem-id'; id: string; problems: string[] }
  /** 試験内で配布ファイル名 (starter の basename) が重なる */
  | { kind: 'duplicate-filename'; filename: string; problems: string[] };

export type ExamBundleBuildResult =
  | { ok: true; exam: ExamDefinition; problems: ExamBundleProblem[] }
  | { ok: false; issues: WorkspaceIssue[] };

/** 試験定義のパスから、採用問題を出題順に配布物の形へ変換する。 */
export async function buildExamBundleProblems(
  examPath: string,
  reader: WorkspaceReader
): Promise<ExamBundleBuildResult> {
  const issues: WorkspaceIssue[] = [];
  const exam = await readDefinition(reader, examPath, null, parseExamDefinition, issues);
  if (!exam) return { ok: false, issues };

  const paths: string[] = [];
  for (const reference of exam.problems) {
    const resolved = resolveWorkspaceReference(examPath, reference);
    if (!resolved.ok) {
      issues.push({ kind: 'invalid-reference', problem: null, source: examPath, reference, reason: resolved.reason });
      continue;
    }
    paths.push(resolved.path);
  }

  const problems = await collectProblems(paths, reader, issues);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, exam, problems };
}

export type ProblemPathsBuildResult =
  | { ok: true; problems: ExamBundleProblem[] }
  | { ok: false; issues: WorkspaceIssue[] };

/**
 * 問題定義のパス (根からの相対パス) の並びから、その順に配布物の形へ変換する。欠損・誤り・重なりの検出は
 * `buildExamBundleProblems` と同じ。試験定義を経ずに書き出す入口 (段階 5 (#797) で試験定義の採否に差し替える)。
 */
export async function buildBundleProblemsFromPaths(
  problemPaths: readonly string[],
  reader: WorkspaceReader
): Promise<ProblemPathsBuildResult> {
  const issues: WorkspaceIssue[] = [];
  const problems = await collectProblems(problemPaths, reader, issues);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, problems };
}

/** 問題を順に組み立て、重なりまで調べる。理由は `issues` に足す。 */
async function collectProblems(
  problemPaths: readonly string[],
  reader: WorkspaceReader,
  issues: WorkspaceIssue[]
): Promise<ExamBundleProblem[]> {
  const problems: ExamBundleProblem[] = [];
  const owners: Owner[] = [];
  for (const problemPath of problemPaths) {
    const built = await buildProblem(reader, problemPath, issues);
    if (!built) continue;
    problems.push(built.problem);
    owners.push({ problemPath, id: built.problem.problemId, filename: built.problem.starter?.filename });
  }
  issues.push(...findDuplicates(owners));
  return problems;
}

/** 問題 1 つを組み立てる。理由は `issues` に足し、1 件でも足したら null。 */
async function buildProblem(
  reader: WorkspaceReader,
  problemPath: string,
  issues: WorkspaceIssue[]
): Promise<{ problem: ExamBundleProblem } | null> {
  const before = issues.length;
  const definition = await readDefinition(reader, problemPath, problemPath, parseProblemDefinition, issues);
  if (!definition) return null;

  const resolve = (reference: string): string | null => {
    const resolved = resolveWorkspaceReference(problemPath, reference);
    if (resolved.ok) return resolved.path;
    issues.push({
      kind: 'invalid-reference',
      problem: problemPath,
      source: problemPath,
      reference,
      reason: resolved.reason,
    });
    return null;
  };

  const statementPath = resolve(definition.statement);
  const starterPath = definition.starter !== undefined ? resolve(definition.starter) : null;
  const casesPath = definition.cases !== undefined ? resolve(definition.cases) : null;
  // ヒントと解答例は配らないので読まないが、欠けていないかは確かめる
  for (const reference of [...definition.hints, ...definition.solutions]) {
    const path = resolve(reference);
    if (path !== null && !(await reader.exists(path)))
      issues.push({ kind: 'missing-file', problem: problemPath, path });
  }

  const statement = statementPath !== null ? await readFile(reader, statementPath, problemPath, issues) : null;
  const starter = starterPath !== null ? await readFile(reader, starterPath, problemPath, issues) : null;
  const cases =
    casesPath !== null ? await readDefinition(reader, casesPath, problemPath, parseCasesDefinition, issues) : null;
  if (issues.length > before) return null;

  const problem: ExamBundleProblem = { problemId: definition.id, statement: statement! };
  if (starterPath !== null) {
    const filename = workspaceBasename(starterPath);
    problem.starter = { filename, language: extensionToLanguage(filename), content: starter! };
  }
  const examples: ProblemExample[] = (cases ?? [])
    .filter((c) => c.public)
    .map((c) => ({ name: c.name, stdin: c.stdin, stdout: c.stdout }));
  if (examples.length > 0) problem.examples = examples;
  return { problem };
}

/** ファイルを読む。無ければ missing-file、読めなければ unreadable-file を足して null。 */
async function readFile(
  reader: WorkspaceReader,
  path: string,
  problem: string | null,
  issues: WorkspaceIssue[]
): Promise<string | null> {
  if (!(await reader.exists(path))) {
    issues.push({ kind: 'missing-file', problem, path });
    return null;
  }
  try {
    return await reader.readText(path);
  } catch (error) {
    issues.push({
      kind: 'unreadable-file',
      problem,
      path,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** 定義ファイルを読んで parse する。読めない・形が違うときは理由を足して null。 */
async function readDefinition<T>(
  reader: WorkspaceReader,
  path: string,
  problem: string | null,
  parse: (text: string) => ParseResult<T>,
  issues: WorkspaceIssue[]
): Promise<T | null> {
  const text = await readFile(reader, path, problem, issues);
  if (text === null) return null;
  const parsed = parse(text);
  if (parsed.ok) return parsed.value;
  issues.push({ kind: 'invalid-definition', problem, path, issues: parsed.issues });
  return null;
}

/** 試験内の `id` と配布ファイル名の重なりを出題順で列挙する。 */
function findDuplicates(owners: readonly Owner[]): WorkspaceIssue[] {
  const issues: WorkspaceIssue[] = [];
  for (const [id, problems] of groupBy(owners, (o) => o.id)) {
    if (problems.length > 1) issues.push({ kind: 'duplicate-problem-id', id, problems });
  }
  for (const [filename, problems] of groupBy(owners, (o) => o.filename)) {
    if (problems.length > 1) issues.push({ kind: 'duplicate-filename', filename, problems });
  }
  return issues;
}

/** 採用問題 1 つの、重なりを調べる値。 */
interface Owner {
  problemPath: string;
  id: string;
  filename?: string;
}

function groupBy(owners: readonly Owner[], keyOf: (owner: Owner) => string | undefined): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const owner of owners) {
    const key = keyOf(owner);
    if (key === undefined) continue;
    const list = groups.get(key) ?? [];
    list.push(owner.problemPath);
    groups.set(key, list);
  }
  return groups;
}
