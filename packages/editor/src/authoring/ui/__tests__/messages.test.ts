import { afterEach, describe, expect, it } from 'vitest';
import { getI18n } from '../../../i18n/index.js';
import type { WorkspaceOpError } from '../../workspace/authorWorkspace.js';
import type { WorkspaceIssue } from '../../workspace/examBundle.js';
import { describeOpError, describeWorkspaceIssue } from '../messages.js';

/** 失敗の種類ごとに 1 つ。どれも文の中に名指しのパスか名前を持つ */
const OP_ERRORS: Array<[WorkspaceOpError, string]> = [
  [{ kind: 'invalid-name', name: '../外' }, '../外'],
  [{ kind: 'exists', path: 'a.md' }, 'a.md'],
  [{ kind: 'unknown-problem', path: 'a.problem.yaml' }, 'a.problem.yaml'],
  [{ kind: 'definition-dirty', path: 'a.problem.yaml' }, 'a.problem.yaml'],
  [{ kind: 'definition-invalid', path: 'a.problem.yaml', issues: [] }, 'a.problem.yaml'],
  [{ kind: 'missing-file', path: 'x.c' }, 'x.c'],
  [{ kind: 'read-failed', path: 'x.c', cause: new Error('boom') }, 'x.c'],
  [
    {
      kind: 'write-failed',
      result: { status: 'conflict', path: 'x.c', reason: 'modified', knownLastModified: 1, currentLastModified: 2 },
    },
    'x.c',
  ],
  [{ kind: 'write-failed', result: { status: 'failed', path: 'x.c', cause: new Error('disk full') } }, 'disk full'],
];

const ISSUES: Array<[WorkspaceIssue, string]> = [
  [{ kind: 'missing-file', problem: 'a.problem.yaml', path: 'a.md' }, 'a.md'],
  [
    {
      kind: 'invalid-reference',
      problem: 'a.problem.yaml',
      source: 'a.problem.yaml',
      reference: '../x',
      reason: 'outside-root',
    },
    '../x',
  ],
  [
    {
      kind: 'invalid-definition',
      problem: 'a.problem.yaml',
      path: 'a.problem.yaml',
      issues: [{ kind: 'missing-key', key: 'statement' }],
    },
    'statement',
  ],
  [{ kind: 'unreadable-file', problem: null, path: 'b.md' }, 'b.md'],
  [{ kind: 'duplicate-problem-id', id: 'p1', problems: ['a.problem.yaml', 'b.problem.yaml'] }, 'b.problem.yaml'],
  [{ kind: 'duplicate-filename', filename: 'main.c', problems: ['a.problem.yaml', 'b.problem.yaml'] }, 'main.c'],
];

afterEach(() => {
  getI18n().setLocale('ja');
});

describe.each(['ja', 'en'] as const)('author messages (%s)', (locale) => {
  it.each(OP_ERRORS)('describes the operation error %j with a translated sentence naming it', (error, named) => {
    getI18n().setLocale(locale);
    const text = describeOpError(error);
    expect([text.startsWith('author.'), text.includes(named)]).toEqual([false, true]);
  });

  it.each(ISSUES)('describes the export issue %j with a translated sentence naming it', (issue, named) => {
    getI18n().setLocale(locale);
    const text = describeWorkspaceIssue(issue);
    expect([text.startsWith('author.'), text.includes(named)]).toEqual([false, true]);
  });
});
