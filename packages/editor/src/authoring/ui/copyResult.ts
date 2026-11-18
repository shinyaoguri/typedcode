/**
 * 問題のコピーの結果 (#800) を、結果のダイアログ (`authorDialogs.showCopyResult`) が描く形にする。DOM に触れない。
 *
 * - `copied`: 書いたファイルの数とコピー先のフォルダ名、書いたパスの一覧
 * - `conflict`: 何も書いていないことと、衝突したパスの一覧
 * - `source-invalid`: 何も書いていないことと、コピー元の理由の一覧 (`WorkspaceIssue`。文は `messages.ts`)
 * - `failed`: 止まった理由、書けたパスと失敗したパス、失敗したパスに空のファイルが残りうること
 * - `dirty`: 先に保存すること、未保存のパスの一覧
 * - `same-folder`: 今開いているフォルダと同じなので何も書いていないこと
 */

import { t } from '../../i18n/index.js';
import type { WorkspaceIssue } from '../workspace/examBundle.js';
import type { ProblemCopyOutcome } from '../workspace/problemCopy.js';
import { describeWriteFailure } from './messages.js';

/** 結果のダイアログに出す結果 (`unknown-problem` は画面が知らせで出す) */
export type CopyResultOutcome = Exclude<ProblemCopyOutcome, { status: 'unknown-problem' }>;
export type CopyResultStatus = CopyResultOutcome['status'];

/** パスの一覧の種類 (状態契約の `data-copy-paths`) */
export type CopyPathListKind = 'written' | 'conflict' | 'dirty' | 'failed';

export interface CopyPathList {
  readonly kind: CopyPathListKind;
  readonly label: string;
  readonly paths: readonly string[];
}

export interface CopyResultView {
  readonly status: CopyResultStatus;
  /** 結果の文 */
  readonly message: string;
  readonly lists: readonly CopyPathList[];
  /** コピー元の理由 (`source-invalid` のときだけ) */
  readonly issues: readonly WorkspaceIssue[];
  /** 添え書き (`failed` のときだけ) */
  readonly note: string | null;
}

/** 結果を画面用の形にする。`folder` はコピー先のフォルダ名 */
export function describeCopyResult(outcome: CopyResultOutcome, folder: string): CopyResultView {
  const view = (message: string, lists: CopyPathList[] = [], extra: Partial<CopyResultView> = {}): CopyResultView => ({
    status: outcome.status,
    message,
    lists,
    issues: [],
    note: null,
    ...extra,
  });
  switch (outcome.status) {
    case 'copied':
      return view(t('author.copyProblem.copied', { folder, n: outcome.written.length }), [
        { kind: 'written', label: t('author.copyProblem.writtenLabel'), paths: outcome.written },
      ]);
    case 'conflict':
      return view(t('author.copyProblem.conflict', { folder }), [
        { kind: 'conflict', label: t('author.copyProblem.conflictLabel'), paths: outcome.paths },
      ]);
    case 'source-invalid':
      return view(t('author.copyProblem.sourceInvalid'), [], { issues: outcome.issues });
    case 'failed': {
      const lists: CopyPathList[] = [];
      if (outcome.written.length > 0) {
        lists.push({
          kind: 'written',
          label: t('author.copyProblem.writtenBeforeFailureLabel'),
          paths: outcome.written,
        });
      }
      lists.push({ kind: 'failed', label: t('author.copyProblem.failedLabel'), paths: [outcome.failed.path] });
      return view(t('author.copyProblem.failed', { folder, reason: describeWriteFailure(outcome.failed) }), lists, {
        note: t('author.copyProblem.failedNote'),
      });
    }
    case 'dirty':
      return view(t('author.copyProblem.dirty'), [
        { kind: 'dirty', label: t('author.copyProblem.dirtyLabel'), paths: outcome.paths },
      ]);
    case 'same-folder':
      return view(t('author.copyProblem.sameFolder'));
  }
}
