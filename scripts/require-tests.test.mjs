/**
 * scripts/require-tests.mjs (テスト必須ゲート / ADR-0034) の判定ロジックの検証。
 *
 * ルートに vitest の設定が無いので node:test で書く。実行: `node --test scripts/require-tests.test.mjs`
 * (CI は deploy.yml の check job)。CLI 部分は入出力の配線だけなので、最後に 1 本だけ
 * 子プロセスで exit code を見る。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { evaluate, extractNoTestReason, isImplementationFile, isTestFile } from './require-tests.mjs';

const SCRIPT = fileURLToPath(new URL('./require-tests.mjs', import.meta.url));

const IMPL = 'packages/editor/src/core/foo.ts';
const UNIT_TEST = 'packages/editor/src/core/__tests__/foo.test.ts';
const REASON_BODY = '## Summary\n\nリファクタ\n\n## テスト不要の理由\n\n挙動を変えない改名だけ。\n\n## Related\n';

function feat(overrides = {}) {
  return { title: 'feat(editor): foo', labels: [], body: '', author: 'someone', ...overrides };
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

  it('does not count non-source files (docs, config, JSON) as implementation changes', () => {
    for (const file of [
      'packages/editor/README.md',
      'packages/editor/vite.config.ts',
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

  it('passes an implementation change accompanied only by an e2e spec change', () => {
    assert.equal(evaluate({ ...feat(), files: [IMPL, 'packages/e2e/tests/happy-path.spec.ts'] }).ok, true);
  });

  it('passes a PR that changes only tests', () => {
    assert.equal(evaluate({ ...feat({ title: 'test: foo' }), files: [UNIT_TEST] }).verdict, 'no-implementation');
  });

  it('passes a PR that changes only docs and config even with a feat title', () => {
    assert.equal(evaluate({ ...feat(), files: ['docs/adr/0034-x.md', 'package.json'] }).ok, true);
  });

  it('exempts docs / ci / chore typed titles even when implementation files change', () => {
    for (const title of ['docs: foo', 'ci(deploy): foo', 'chore!: foo']) {
      assert.equal(evaluate({ ...feat({ title }), files: [IMPL] }).verdict, 'exempt', title);
    }
  });

  it('exempts dependency bump titles', () => {
    for (const title of ['fix(deps): bump foo', 'feat(deps-dev): bump bar']) {
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

describe('CLI', () => {
  function run(files, env) {
    return spawnSync(process.execPath, [SCRIPT], {
      input: `${files.join('\n')}\n`,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...env },
    });
  }

  it('exits 1 with an ::error:: annotation when tests are missing', () => {
    const child = run([IMPL], { PR_TITLE: 'feat: foo', PR_LABELS: '[]' });
    assert.equal(child.status, 1);
    assert.match(child.stdout, /^::error /m);
  });

  it('exits 0 when the change is accompanied by tests', () => {
    assert.equal(run([IMPL, UNIT_TEST], { PR_TITLE: 'feat: foo' }).status, 0);
  });

  it('exits 2 when PR_LABELS is not a JSON array', () => {
    assert.equal(run([IMPL], { PR_TITLE: 'feat: foo', PR_LABELS: 'no-test-needed' }).status, 2);
  });
});
