/**
 * scripts/require-tests.mjs (テスト必須ゲート / ADR-0034) の判定ロジックの検証。
 *
 * ルートに vitest の設定が無いので node:test で書く。実行: `node --test scripts/require-tests.test.mjs`
 * (CI は deploy.yml の check job)。CLI 部分は入出力の配線だけなので、最後に 1 本だけ
 * 子プロセスで exit code を見る。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { evaluate, extractNoTestReason, isImplementationFile, isTestFile, parsePr } from './require-tests.mjs';

const SCRIPT = fileURLToPath(new URL('./require-tests.mjs', import.meta.url));
const PR_TEMPLATE = readFileSync(new URL('../.github/pull_request_template.md', import.meta.url), 'utf8');

const IMPL = 'packages/editor/src/core/foo.ts';
const UNIT_TEST = 'packages/editor/src/core/__tests__/foo.test.ts';
const REASON_BODY = '## Summary\n\nリファクタ\n\n## テスト不要の理由\n\n挙動を変えない改名だけ。\n\n## Related\n';

function feat(overrides = {}) {
  return { title: 'feat(editor): foo', labels: [], body: '', author: 'someone', ...overrides };
}

/** `gh pr view --json title,body,labels,author` の出力の形 (CLI の --pr に渡すもの)。 */
function ghPr({ title = 'feat(editor): foo', body = '', labels = [], login = 'someone' } = {}) {
  return {
    title,
    body,
    labels: labels.map((name, i) => ({ id: `LA_${i}`, name, description: '', color: 'ededed' })),
    author: { id: 'U_1', is_bot: login.startsWith('app/'), login, name: '' },
  };
}

describe('file classification', () => {
  it('counts a non-test source file under packages/*/src as an implementation change', () => {
    assert.equal(isImplementationFile(IMPL), true);
  });

  it('counts CSS under packages/*/src as an implementation change', () => {
    assert.equal(isImplementationFile('packages/verify/src/styles/main.css'), true);
  });

  it('counts a package-root HTML page entry as an implementation change', () => {
    assert.equal(isImplementationFile('packages/editor/index.html'), true);
  });

  it('does not count a test file under src as an implementation change', () => {
    assert.equal(isImplementationFile(UNIT_TEST), false);
  });

  it('counts delivery config (vite.config.ts, public/_headers, workers wrangler*.toml) as an implementation change', () => {
    for (const file of [
      'packages/editor/public/_headers',
      'packages/editor/vite.config.ts',
      'packages/workers/wrangler.production.toml',
      'packages/verify/public/_headers',
      'packages/verify/vite.config.ts',
      'packages/workers/wrangler.toml',
      'packages/workers/wrangler.staging.toml',
    ]) {
      assert.equal(isImplementationFile(file), true, file);
    }
  });

  it('does not count non-source files (docs, test config, JSON, other public assets) as implementation changes', () => {
    for (const file of [
      'packages/editor/README.md',
      'packages/editor/vitest.config.ts',
      'packages/editor/package.json',
      'packages/editor/public/favicon.svg',
      'packages/shared/src/data.json',
    ]) {
      assert.equal(isImplementationFile(file), false, file);
    }
  });

  it('counts __tests__ fixtures, *.test.ts, e2e specs and script tests as test changes', () => {
    for (const file of [
      'packages/shared/src/__tests__/fixtures/proof.json',
      'packages/verify/src/foo.test.ts',
      'packages/e2e/tests/helpers/app.ts',
      'scripts/sweep.test.ts',
      'scripts/require-tests.test.mjs',
    ]) {
      assert.equal(isTestFile(file), true, file);
    }
  });

  it('does not count the @shots capture spec as a test change, since it asserts nothing', () => {
    for (const file of ['packages/e2e/tests/shots.spec.ts', 'packages/e2e/tests/verify.shots.spec.ts']) {
      assert.equal(isTestFile(file), false, file);
    }
  });

  it('still counts an e2e spec whose name merely ends in "shots" as a test change', () => {
    assert.equal(isTestFile('packages/e2e/tests/screenshots.spec.ts'), true);
  });
});

describe('evaluate', () => {
  it('fails an implementation change that has no test change', () => {
    const outcome = evaluate({ ...feat(), files: [IMPL] });
    assert.equal(outcome.ok, false);
    assert.deepEqual(outcome.implementationFiles, [IMPL]);
  });

  it('passes an implementation change accompanied by a unit test change', () => {
    assert.equal(evaluate({ ...feat(), files: [IMPL, UNIT_TEST] }).ok, true);
  });

  it('fails an implementation change accompanied only by the @shots capture spec', () => {
    assert.equal(evaluate({ ...feat(), files: [IMPL, 'packages/e2e/tests/shots.spec.ts'] }).ok, false);
  });

  it('passes an implementation change accompanied only by an e2e spec change', () => {
    assert.equal(evaluate({ ...feat(), files: [IMPL, 'packages/e2e/tests/happy-path.spec.ts'] }).ok, true);
  });

  it('passes a PR that changes only tests', () => {
    assert.equal(evaluate({ ...feat({ title: 'test: foo' }), files: [UNIT_TEST] }).verdict, 'no-implementation');
  });

  it('passes a PR that changes only docs and config even with a feat title', () => {
    assert.equal(evaluate({ ...feat(), files: ['docs/adr/0034-x.md', 'package.json'] }).ok, true);
  });

  it('fails a chore PR that changes packages/editor/src/x.ts without a test change', () => {
    const outcome = evaluate({ ...feat({ title: 'chore: foo' }), files: ['packages/editor/src/x.ts'] });
    assert.equal(outcome.verdict, 'missing-tests');
  });

  it('exempts a chore PR that changes only docs/ by its title type', () => {
    const outcome = evaluate({ ...feat({ title: 'chore: foo' }), files: ['docs/adr/0034-x.md', 'docs/setup.md'] });
    assert.equal(outcome.verdict, 'exempt');
  });

  it('does not exempt docs / ci typed titles either when implementation files change', () => {
    for (const title of ['docs: foo', 'ci(deploy): foo', 'chore!: foo']) {
      assert.equal(evaluate({ ...feat({ title }), files: [IMPL] }).verdict, 'missing-tests', title);
    }
  });

  it('fails a chore PR that changes only delivery config without a test change', () => {
    const outcome = evaluate({ ...feat({ title: 'chore(workers): foo' }), files: ['packages/workers/wrangler.toml'] });
    assert.equal(outcome.verdict, 'missing-tests');
  });

  it('waives a chore PR with implementation changes by the no-test-needed label and a reason', () => {
    const outcome = evaluate({
      ...feat({ title: 'chore: foo', labels: ['no-test-needed'], body: REASON_BODY }),
      files: [IMPL],
    });
    assert.equal(outcome.verdict, 'waived');
  });

  it('exempts dependency bump titles', () => {
    for (const title of ['fix(deps): bump foo', 'feat(deps-dev): bump bar', 'chore(deps): bump baz']) {
      assert.equal(evaluate({ ...feat({ title }), files: [IMPL] }).verdict, 'exempt', title);
    }
  });

  it('exempts PRs authored by dependabot', () => {
    assert.equal(evaluate({ ...feat({ author: 'dependabot[bot]' }), files: [IMPL] }).verdict, 'exempt');
  });

  it('does not exempt a title that merely mentions docs outside the type', () => {
    assert.equal(evaluate({ ...feat({ title: 'fix(editor): docs link' }), files: [IMPL] }).ok, false);
  });

  it('fails when the no-test-needed label is set but the reason heading is missing', () => {
    assert.equal(evaluate({ ...feat({ labels: ['no-test-needed'] }), files: [IMPL] }).ok, false);
  });

  it('fails when the no-test-needed label is set but the reason holds only the template comment', () => {
    const body = '## テスト不要の理由\n\n<!-- 該当時のみ記入 -->\n\n## Related\n';
    assert.equal(evaluate({ ...feat({ labels: ['no-test-needed'], body }), files: [IMPL] }).ok, false);
  });

  it('fails when a reason is written but the no-test-needed label is missing', () => {
    assert.equal(evaluate({ ...feat({ body: REASON_BODY }), files: [IMPL] }).ok, false);
  });

  it('fails when the no-test-needed label is set on an untouched PR template body', () => {
    const outcome = evaluate({ ...feat({ labels: ['no-test-needed'], body: PR_TEMPLATE }), files: [IMPL] });
    assert.equal(outcome.ok, false);
  });

  it('passes when the reason is filled into the PR template and the label is set', () => {
    const body = PR_TEMPLATE.replace('## テスト不要の理由\n', '## テスト不要の理由\n\n挙動を変えない改名だけ。\n');
    assert.notEqual(body, PR_TEMPLATE);
    const outcome = evaluate({ ...feat({ labels: ['no-test-needed'], body }), files: [IMPL] });
    assert.equal(outcome.verdict, 'waived');
  });

  it('passes when the no-test-needed label is set and the reason section has text', () => {
    const outcome = evaluate({ ...feat({ labels: ['no-test-needed'], body: REASON_BODY }), files: [IMPL] });
    assert.equal(outcome.verdict, 'waived');
  });
});

describe('extractNoTestReason', () => {
  it('returns null when the heading is absent', () => {
    assert.equal(extractNoTestReason('## Summary\n\nfoo'), null);
  });

  it('stops the section at the next level-2 heading', () => {
    assert.equal(extractNoTestReason(REASON_BODY), '挙動を変えない改名だけ。');
  });

  it('keeps level-3 subheadings inside the section', () => {
    assert.equal(extractNoTestReason('## テスト不要の理由\n### 詳細\n改名だけ'), '### 詳細\n改名だけ');
  });

  it('strips multi-line HTML comments and CRLF line endings', () => {
    assert.equal(extractNoTestReason('## テスト不要の理由\r\n<!--\r\nhint\r\n-->\r\n理由\r\n'), '理由');
  });
});

describe('parsePr', () => {
  it('maps gh pr view output to the title, body, label names and author login', () => {
    const json = ghPr({ title: 'feat: foo', body: 'b', labels: ['no-test-needed', 'pkg:editor'], login: 'someone' });
    assert.deepEqual(parsePr(json), {
      title: 'feat: foo',
      body: 'b',
      labels: ['no-test-needed', 'pkg:editor'],
      author: 'someone',
    });
  });

  it('spells a gh bot login (app/<slug>) as the payload does, so dependabot stays exempt', () => {
    const pr = parsePr(ghPr({ login: 'app/dependabot' }));
    assert.equal(evaluate({ ...pr, files: [IMPL] }).verdict, 'exempt');
  });

  it('rejects JSON without labels instead of judging it as unlabeled', () => {
    const { labels: _labels, ...withoutLabels } = ghPr();
    assert.throws(() => parsePr(withoutLabels), /labels が配列ではない/);
  });
});

describe('CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'require-tests-'));
  function prFile(json) {
    const path = join(dir, `pr-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify(json));
    return path;
  }
  function run(files, args, env = {}) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      input: `${files.join('\n')}\n`,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...env },
    });
  }

  it('exits 1 with an ::error:: annotation when tests are missing', () => {
    const child = run([IMPL], ['--pr', prFile(ghPr())]);
    assert.equal(child.status, 1);
    assert.match(child.stdout, /^::error /m);
  });

  it('exits 0 when the change is accompanied by tests', () => {
    assert.equal(run([IMPL, UNIT_TEST], ['--pr', prFile(ghPr())]).status, 0);
  });

  it('waives by the no-test-needed label in the PR JSON', () => {
    const pr = ghPr({ labels: ['no-test-needed'], body: REASON_BODY });
    assert.equal(run([IMPL], ['--pr', prFile(pr)]).status, 0);
  });

  it('judges by the current labels in the PR JSON, ignoring a stale PR_LABELS env', () => {
    const child = run([IMPL], ['--pr', prFile(ghPr({ body: REASON_BODY }))], {
      PR_LABELS: '["no-test-needed"]',
      PR_TITLE: 'docs: foo',
    });
    assert.equal(child.status, 1);
  });

  it('exits 2 when --pr is not given', () => {
    assert.equal(run([IMPL], []).status, 2);
  });

  it('exits 2 when the PR JSON is broken', () => {
    const path = join(dir, 'broken.json');
    writeFileSync(path, '{"title":');
    assert.equal(run([IMPL], ['--pr', path]).status, 2);
  });
});
