/**
 * 問題を別の教材フォルダへコピーする操作のうち、画面に依らない部分 (#800 / ADR-0051 Decision 8、system-spec §4.10)。
 * DOM に触れない。コピーそのものの規則 (調べ終えてから書く・定義を最後に書く・衝突があれば何も書かない・中身を
 * 1 文字も変えない) は `copyProblem.ts` が持ち、ここでは変えない。
 *
 * - **対象は保存済みの内容**: 問題定義とその参照ファイル (解決できたもの) のうち、未保存の文書が 1 つでもあれば
 *   コピーしない (`dirty`)。関係の無い文書が未保存でも止めない
 * - コピー元は `AuthorWorkspace.reader()` (開いている文書は保存済みのテキストを使い、ファイルを裏で読み直さない。
 *   読み直すと `MaterialFolder` が覚えている `lastModified` が進み、次の保存で外部の変更を競合として検出できなくなる)
 * - 読めない定義の問題はコピーの対象にしない (`unknown-problem`)
 * - コピー先は呼び出し側が選んだフォルダ。**「前回のフォルダ」として覚えない** (`FolderHandleStore` に触れない)
 */

import type { IndexedProblem } from './authorWorkspace.js';
import { type CopyDestination, type CopyProblemResult, copyProblem } from './copyProblem.js';
import type { WorkspaceReader } from './reader.js';

/** コピーに要る作問画面の状態 (`AuthorWorkspace` が満たす) */
export interface ProblemCopySource {
  problem(path: string): IndexedProblem | undefined;
  dirtyPaths(): string[];
  reader(): WorkspaceReader;
  refresh(): Promise<unknown>;
}

/** コピーを始めない理由 */
export type ProblemCopyBlocker =
  /** 問題定義か参照ファイルに未保存の編集がある。`paths` はその文書のパス */
  | { readonly status: 'dirty'; readonly paths: readonly string[] }
  /** 問題定義が索引に無いか、読めない定義 */
  | { readonly status: 'unknown-problem'; readonly path: string };

/** コピーの操作の結果 (画面が出し分ける全部) */
export type ProblemCopyOutcome =
  | CopyProblemResult
  | ProblemCopyBlocker
  /** コピー先が今開いているフォルダと同じ。何も書いていない */
  | { readonly status: 'same-folder' };

function nfc(path: string): string {
  return path.normalize('NFC');
}

/**
 * この問題をコピーしてよいか。止める理由があれば返し、無ければ null。同期で答える (ピッカーをクリックの中で
 * 開けるように、呼び出し側はこの後 await を挟まずにピッカーを開く)。
 */
export function problemCopyBlocker(source: ProblemCopySource, problemPath: string): ProblemCopyBlocker | null {
  const problem = source.problem(problemPath);
  if (problem?.status !== 'ok') return { status: 'unknown-problem', path: problemPath };
  const related = new Set(
    [problem.path, ...problem.parts.flatMap((part) => (part.path === null ? [] : [part.path]))].map(nfc)
  );
  const dirty = source.dirtyPaths().filter((path) => related.has(nfc(path)));
  return dirty.length > 0 ? { status: 'dirty', paths: dirty } : null;
}

/**
 * 問題を参照ファイルごとコピー先へ書く。索引を読み直してから、もう一度止める理由を調べる (ピッカーを開いている
 * 間に編集・削除されていても、保存済みの今の内容だけを写す)。例外は投げず結果で返す。
 */
export async function copyProblemToFolder(
  source: ProblemCopySource,
  problemPath: string,
  destination: CopyDestination
): Promise<ProblemCopyOutcome> {
  try {
    await source.refresh();
  } catch (cause) {
    return { status: 'failed', written: [], failed: { status: 'failed', path: problemPath, cause } };
  }
  const blocker = problemCopyBlocker(source, problemPath);
  if (blocker) return blocker;
  const problem = source.problem(problemPath);
  // problemCopyBlocker が ok を確かめている
  const path = problem?.path ?? problemPath;
  return copyProblem(source.reader(), path, destination);
}

/**
 * 2 つのフォルダが同じか。`isSameEntry` を持たないハンドル・調べられないときは null (分からない)。
 * 分からなければ呼び出し側はコピーを進めてよい (同じフォルダなら衝突の結果として出る)。
 */
export async function isSameFolder(
  a: FileSystemDirectoryHandle,
  b: FileSystemDirectoryHandle
): Promise<boolean | null> {
  if (typeof a.isSameEntry !== 'function') return null;
  try {
    return await a.isSameEntry(b);
  } catch {
    return null;
  }
}
