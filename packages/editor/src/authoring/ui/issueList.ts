/**
 * 教材の欠損・重なり (`WorkspaceIssue`) の一覧を描く (#797)。学生プレビューと書き出しのパネルが使う。
 *
 * 状態契約: `ul[data-issues]` の項目 `li` に `data-issue-kind` (`WorkspaceIssue['kind']`)、属する問題定義のパスが
 * あれば `data-problem`、ファイルのパスがあれば `data-path`。文は `describeWorkspaceIssue` (textContent で入れる)。
 */

import type { WorkspaceIssue } from '../workspace/examBundle.js';
import { describeWorkspaceIssue } from './messages.js';

export function renderIssueList(issues: readonly WorkspaceIssue[]): HTMLUListElement {
  const list = document.createElement('ul');
  list.className = 'author-issues';
  list.dataset.issues = '';
  for (const issue of issues) {
    const item = document.createElement('li');
    item.dataset.issueKind = issue.kind;
    if ('problem' in issue && issue.problem !== null) item.dataset.problem = issue.problem;
    if ('path' in issue) item.dataset.path = issue.path;
    item.textContent = describeWorkspaceIssue(issue);
    list.appendChild(item);
  }
  return list;
}
