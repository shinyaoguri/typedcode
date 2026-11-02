/**
 * scripts/require-issue.mjs (Issue の紐づけゲート / ADR-0038) の判定ロジックの検証。
 *
 * ルートに vitest の設定が無いので node:test で書く。実行: `node --test 'scripts/*.test.mjs'`
 * (CI は deploy.yml の check job)。CLI 部分は入出力の配線だけなので、最後に子プロセスで
 * exit code を見る。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { evaluate, NO_ISSUE_LABEL } from './require-issue.mjs';

const SCRIPT = fileURLToPath(new URL('./require-issue.mjs', import.meta.url));
const REPO = 'shinyaoguri/typedcode';

function ref(number, owner = 'shinyaoguri', name = 'typedcode') {
  return { number, repository: { name, owner: { login: owner } } };
}

function pr(overrides = {}) {
  return { closing: [], labels: [], author: 'someone', repo: REPO, ...overrides };
}

describe('evaluate', () => {
  it('passes when the PR closes an issue of its own repository', () => {
    const outcome = evaluate(pr({ closing: [ref(478)] }));
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.ownIssues, [478]);
  });

  it('fails when the PR closes no issue', () => {
    const outcome = evaluate(pr());
    assert.equal(outcome.ok, false);
    assert.equal(outcome.verdict, 'missing-issue');
  });

  it('passes a PR without a closing reference when it carries the no-issue label', () => {
    assert.equal(evaluate(pr({ labels: [NO_ISSUE_LABEL] })).verdict, 'waived');
  });

  it('passes a dependabot PR without a closing reference', () => {
    assert.equal(evaluate(pr({ author: 'dependabot[bot]' })).verdict, 'dependabot');
  });

  it('fails when the PR only closes issues of other repositories', () => {
    const outcome = evaluate(pr({ closing: [ref(1, 'someone-else', 'typedcode'), ref(2, 'shinyaoguri', 'mokume')] }));
    assert.equal(outcome.ok, false);
    assert.deepEqual(outcome.foreignRefs, ['someone-else/typedcode#1', 'shinyaoguri/mokume#2']);
  });

  it('passes when own-repository and foreign references are mixed', () => {
    assert.equal(evaluate(pr({ closing: [ref(1, 'other', 'repo'), ref(478)] })).ok, true);
  });

  it('matches the own repository case-insensitively', () => {
    assert.equal(evaluate(pr({ closing: [ref(478, 'ShinyaOguri', 'TypedCode')] })).ok, true);
  });

  it('does not exempt a docs / ci / chore typed title', () => {
    for (const title of ['docs: foo', 'ci(repo): foo', 'chore: foo']) {
      assert.equal(evaluate({ ...pr(), title }).ok, false, title);
    }
  });
});

describe('CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'require-issue-'));
  function closingFile(content) {
    const path = join(dir, `closing-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, content);
    return path;
  }
  function run(content, env = {}) {
    return spawnSync(process.execPath, [SCRIPT, '--closing', closingFile(content)], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, GITHUB_REPOSITORY: REPO, PR_AUTHOR: 'someone', PR_LABELS: '[]', ...env },
    });
  }

  it('exits 0 when the PR closes an issue of its own repository', () => {
    assert.equal(run(JSON.stringify({ closingIssuesReferences: [ref(478)] })).status, 0);
  });

  it('exits 1 with an ::error:: annotation when the PR closes no issue, even with a docs title', () => {
    const child = run('{"closingIssuesReferences":[]}', { PR_TITLE: 'docs: foo' });
    assert.equal(child.status, 1);
    assert.match(child.stdout, /^::error /m);
  });

  it('exits 0 when the no-issue label is set', () => {
    assert.equal(run('{"closingIssuesReferences":[]}', { PR_LABELS: '["no-issue"]' }).status, 0);
  });

  it('exits 2 when the closing JSON is broken', () => {
    assert.equal(run('{"closingIssuesReferences":').status, 2);
  });

  it('exits 2 with an input error naming closingIssuesReferences when it is not an array', () => {
    const child = run('{"closingIssuesReferences":null}');
    assert.equal(child.status, 2);
    assert.match(child.stderr, /closingIssuesReferences が配列ではない/);
  });

  it('exits 2 when GITHUB_REPOSITORY is not set', () => {
    assert.equal(run('{"closingIssuesReferences":[]}', { GITHUB_REPOSITORY: '' }).status, 2);
  });
});
