/**
 * 作問画面の状態の結果 (操作の失敗・書き出しを止めた理由) を、人に見せる文にする (#796)。
 * 理由は状態の層が機械可読な形で返し、文言はここで i18n から作る。
 */

import { t } from '../../i18n/index.js';
import type { ProblemPartRole, WorkspaceOpError } from '../workspace/authorWorkspace.js';
import type { WorkspaceIssue } from '../workspace/examBundle.js';
import type { FolderWriteResult } from '../workspace/materialFolder.js';

export function roleLabel(role: ProblemPartRole): string {
  return t(`author.roles.${role}`);
}

/** 例外・失敗の原因を短い文字列にする */
export function causeMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message || cause.name;
  return String(cause);
}

/** 書き込みの結果 (`saved` 以外) を文にする */
export function describeWriteFailure(result: Exclude<FolderWriteResult, { status: 'saved' }>): string {
  if (result.status === 'conflict') return t('author.notices.writeConflict', { path: result.path });
  return t('author.notices.writeFailed', { path: result.path, message: causeMessage(result.cause) });
}

export function describeOpError(error: WorkspaceOpError): string {
  switch (error.kind) {
    case 'invalid-name':
      return t('author.notices.invalidName', { name: error.name });
    case 'exists':
      return t('author.notices.exists', { path: error.path });
    case 'unknown-problem':
      return t('author.notices.unknownProblem', { path: error.path });
    case 'definition-dirty':
      return t('author.notices.definitionDirty', { path: error.path });
    case 'definition-invalid':
      return t('author.notices.definitionInvalid', { path: error.path });
    case 'already-assigned':
      return t('author.notices.alreadyAssigned', { role: roleLabel(error.role) });
    case 'missing-file':
      return t('author.notices.missingFile', { path: error.path });
    case 'read-failed':
      return t('author.notices.readFailed', { path: error.path });
    case 'write-failed':
      return describeWriteFailure(error.result);
  }
}

/** 書き出しを止めた理由 1 件を文にする。問題のパスが無い (試験定義そのものの) 理由は `-` を前に置く */
export function describeWorkspaceIssue(issue: WorkspaceIssue): string {
  switch (issue.kind) {
    case 'missing-file':
      return t('author.issues.missingFile', { problem: issue.problem ?? '-', path: issue.path });
    case 'invalid-reference':
      return t('author.issues.invalidReference', {
        problem: issue.problem ?? issue.source,
        reference: issue.reference,
        reason: issue.reason,
      });
    case 'invalid-definition':
      return t('author.issues.invalidDefinition', {
        problem: issue.problem ?? '-',
        path: issue.path,
        detail: issue.issues
          .map((detail) => ('key' in detail && detail.key ? `${detail.kind}: ${detail.key}` : detail.kind))
          .join(', '),
      });
    case 'unreadable-file':
      return t('author.issues.unreadableFile', { problem: issue.problem ?? '-', path: issue.path });
    case 'duplicate-problem-id':
      return t('author.issues.duplicateId', { id: issue.id, problems: issue.problems.join(', ') });
    case 'duplicate-filename':
      return t('author.issues.duplicateFilename', { filename: issue.filename, problems: issue.problems.join(', ') });
  }
}
