/**
 * 作問画面の状態の結果 (操作の失敗・書き出しを止めた理由) を、人に見せる文にする (#796)。
 * 理由は状態の層が機械可読な形で返し、文言はここで i18n から作る。
 */

import { t } from '../../i18n/index.js';
import type { ProblemPartRole, WorkspaceOpError } from '../workspace/authorWorkspace.js';
import type { WorkspaceIssue } from '../workspace/examBundle.js';
import type { FolderWriteResult } from '../workspace/materialFolder.js';
import type { VerificationBlockReason } from '../verification/collectTargets.js';

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

/** 検証を始めなかった理由を文にする (#799) */
export function describeVerificationBlock(reason: VerificationBlockReason | { kind: 'terminal-busy' }): string {
  switch (reason.kind) {
    case 'problem-invalid':
      return t('author.verify.reasons.problemInvalid', { path: reason.path });
    case 'no-solutions':
      return t('author.verify.reasons.noSolutions');
    case 'no-cases':
      return t('author.verify.reasons.noCases');
    case 'missing-file':
      return t('author.verify.reasons.missingFile', { path: reason.path });
    case 'read-failed':
      return t('author.verify.reasons.readFailed', { path: reason.path });
    case 'cases-invalid':
      return t('author.verify.reasons.casesInvalid', { path: reason.path });
    case 'empty-cases':
      return t('author.verify.reasons.emptyCases', { path: reason.path });
    case 'terminal-busy':
      return t('author.verify.reasons.terminalBusy');
  }
}
