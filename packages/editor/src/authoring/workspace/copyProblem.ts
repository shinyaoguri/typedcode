/**
 * 問題を参照ファイルごと別の教材フォルダへコピーする (#817 / ADR-0051 Decision 8、system-spec §4.10)。
 *
 * - コピーするのは問題定義と、それが参照するファイル (本文・初期コード・ヒント・解答例・ケース)。
 *   **コピー元の根からの相対パスをそのままコピー先のパスに使う** (定義の中の参照を書き換えずに済む)。
 *   他の問題と共有しているファイルもコピーする。同じパスは 1 度だけ書く
 * - 中身は 1 文字も変えない (問題定義の `id`・コメント・未知のキーを保つ。ケースも parse した値ではなくテキストを写す)
 * - **調べてから書く**: コピー元の欠損・誤り (定義が読めない・参照が解決できない・参照先が無い) は全部集めて
 *   返し、何も書かない。コピー先に同じパスのファイルが 1 つでもあれば、衝突したパスを全部返して何も書かない
 * - 書き込みの途中で失敗したら (権限の取り消しなど) そこで止め、書けたパスと失敗した結果を返す。
 *   取り消しはしない (`MaterialFolder` に削除が無い)。問題定義は最後に書くので、途中で失敗しても
 *   参照先の欠けた定義がコピー先に残りにくい
 * - 例外は投げず、結果で返す
 *
 * UI・フォルダの選択はここに無い (#800)。
 */

import { parseProblemDefinition } from './definitions.js';
import type { WorkspaceIssue } from './examBundle.js';
import type { FolderWriteResult } from './materialFolder.js';
import { resolveWorkspaceReference } from './paths.js';
import type { WorkspaceReader } from './reader.js';

/** コピー先に要るもの。`MaterialFolder` が構造的に満たす。パスは根からの相対 POSIX パス */
export interface CopyDestination {
  exists(path: string): Promise<boolean>;
  /** 新しいファイルを作る。同じパスにファイルが在れば書かずに `conflict` を返す */
  createFile(path: string, text: string): Promise<FolderWriteResult>;
}

/** 書けなかった 1 件 (`createFile` が `saved` 以外を返した、またはコピー先を調べられなかった) */
export type CopyWriteFailure = Exclude<FolderWriteResult, { status: 'saved' }>;

export type CopyProblemResult =
  /** 全部書けた。`written` は書いた順 (問題定義が最後) */
  | { status: 'copied'; written: string[] }
  /** コピー元に欠損・誤りがある。何も書いていない */
  | { status: 'source-invalid'; issues: WorkspaceIssue[] }
  /** コピー先に同じパスのファイルが在る。何も書いていない */
  | { status: 'conflict'; paths: string[] }
  /** 途中で失敗した。`written` は書けたパス (取り消していない)、`failed` は止まった 1 件 */
  | { status: 'failed'; written: string[]; failed: CopyWriteFailure };

/** 問題定義 (`problemPath`) と参照ファイル一式を、同じ相対パスでコピー先へ書く。 */
export async function copyProblem(
  source: WorkspaceReader,
  problemPath: string,
  destination: CopyDestination
): Promise<CopyProblemResult> {
  // 1・2. コピー元を全部読む (理由は全部集める)
  const issues: WorkspaceIssue[] = [];
  const definitionText = await readSource(source, problemPath, problemPath, issues);
  if (definitionText === null) return { status: 'source-invalid', issues };
  const parsed = parseProblemDefinition(definitionText);
  if (!parsed.ok) {
    issues.push({ kind: 'invalid-definition', problem: problemPath, path: problemPath, issues: parsed.issues });
    return { status: 'source-invalid', issues };
  }

  const definition = parsed.value;
  const references = [
    definition.statement,
    ...(definition.starter !== undefined ? [definition.starter] : []),
    ...definition.hints,
    ...definition.solutions,
    ...(definition.cases !== undefined ? [definition.cases] : []),
  ];
  const referencePaths = new Set<string>();
  for (const reference of references) {
    const resolved = resolveWorkspaceReference(problemPath, reference);
    if (resolved.ok) {
      if (resolved.path !== problemPath) referencePaths.add(resolved.path);
      continue;
    }
    issues.push({
      kind: 'invalid-reference',
      problem: problemPath,
      source: problemPath,
      reference,
      reason: resolved.reason,
    });
  }

  // 問題定義を最後に書く
  const files: Array<{ path: string; text: string }> = [];
  for (const path of referencePaths) {
    const text = await readSource(source, path, problemPath, issues);
    if (text !== null) files.push({ path, text });
  }
  if (issues.length > 0) return { status: 'source-invalid', issues };
  files.push({ path: problemPath, text: definitionText });

  // 3. コピー先との衝突を全部調べる
  const conflicts: string[] = [];
  for (const { path } of files) {
    try {
      if (await destination.exists(path)) conflicts.push(path);
    } catch (cause) {
      return { status: 'failed', written: [], failed: { status: 'failed', path, cause } };
    }
  }
  if (conflicts.length > 0) return { status: 'conflict', paths: conflicts };

  // 4. 書く (失敗したらそこで止める)
  const written: string[] = [];
  for (const { path, text } of files) {
    let result: FolderWriteResult;
    try {
      result = await destination.createFile(path, text);
    } catch (cause) {
      result = { status: 'failed', path, cause };
    }
    if (result.status !== 'saved') return { status: 'failed', written, failed: result };
    written.push(path);
  }
  return { status: 'copied', written };
}

/** コピー元のファイルを読む。無ければ missing-file、読めなければ unreadable-file を足して null。 */
async function readSource(
  source: WorkspaceReader,
  path: string,
  problem: string,
  issues: WorkspaceIssue[]
): Promise<string | null> {
  try {
    if (!(await source.exists(path))) {
      issues.push({ kind: 'missing-file', problem, path });
      return null;
    }
    return await source.readText(path);
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
