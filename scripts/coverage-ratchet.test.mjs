/**
 * scripts/coverage-ratchet.mjs (カバレッジの床を上げられる値の知らせ / #472) の判定ロジックの検証。
 *
 * ルートに vitest の設定が無いので node:test で書く。実行: `node --test scripts/coverage-ratchet.test.mjs`
 * (`npm run check:fast` の `node --test 'scripts/*.test.mjs'` に自動で乗る)。
 * ファイルを読み書きする CLI 部分は入出力の配線だけなので、diff の読み取りと判定の純関数、
 * Issue 本文の組み立てを検証する。入力は `git diff -U0` の実際の出力と同じ形にする。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ISSUE_TITLE, evaluateCoverageRatchet, formatIssueBody, parseFloorChanges } from './coverage-ratchet.mjs';

/** `git diff -U0` と同じ形の、1 ファイル分の diff。changes は [指標, 前, 後] の並び。 */
function fileDiff(pkg, changes) {
  const hunks = changes.flatMap(([metric, from, to], index) => [
    `@@ -${20 + index} +${20 + index} @@ export default defineConfig({`,
    `-        ${metric}: ${from},`,
    `+        ${metric}: ${to},`,
  ]);
  return [
    `diff --git a/packages/${pkg}/vitest.config.ts b/packages/${pkg}/vitest.config.ts`,
    'index 1111111..2222222 100644',
    `--- a/packages/${pkg}/vitest.config.ts`,
    `+++ b/packages/${pkg}/vitest.config.ts`,
    ...hunks,
    '',
  ].join('\n');
}

describe('evaluateCoverageRatchet (Issue #472 の 3 例)', () => {
  it('reports editor branches 21 → 23 as a floor that can be raised', () => {
    const result = evaluateCoverageRatchet(fileDiff('editor', [['branches', 21, 23]]));
    assert.equal(result.notify, true);
    assert.deepEqual(result.raises, [{ pkg: 'editor', metric: 'branches', from: 21, to: 23 }]);

    const body = formatIssueBody(result.raises);
    assert.match(body, /`editor`/);
    assert.match(body, /`branches`/);
    assert.match(body, /21 → 23/);
  });

  it('does not notify when the diff is empty', () => {
    const result = evaluateCoverageRatchet('');
    assert.equal(result.notify, false);
    assert.equal(result.count, 0);
    assert.deepEqual(result.raises, []);
  });

  it('does not treat a floor that goes down (branches 21 → 20) as a value that can be raised', () => {
    const result = evaluateCoverageRatchet(fileDiff('editor', [['branches', 21, 20]]));
    assert.equal(result.notify, false);
    assert.deepEqual(result.raises, []);
  });
});

describe('parseFloorChanges', () => {
  it('pairs every metric changed in one package, in lines / functions / branches / statements order', () => {
    const diff = fileDiff('shared', [
      ['statements', 77, 79],
      ['lines', 78, 80],
      ['branches', 73, 75],
    ]);
    assert.deepEqual(parseFloorChanges(diff), [
      { pkg: 'shared', metric: 'lines', from: 78, to: 80 },
      { pkg: 'shared', metric: 'branches', from: 73, to: 75 },
      { pkg: 'shared', metric: 'statements', from: 77, to: 79 },
    ]);
  });

  it('keeps each package apart and sorts by package name', () => {
    const diff = fileDiff('verify', [['lines', 29, 31]]) + fileDiff('editor', [['lines', 30, 32]]);
    assert.deepEqual(
      parseFloorChanges(diff).map((c) => `${c.pkg}:${c.metric}:${c.from}→${c.to}`),
      ['editor:lines:30→32', 'verify:lines:29→31']
    );
  });

  it('does not notify for an unchanged value or a metric that only appears on one side', () => {
    const diff = [
      fileDiff('editor', [['lines', 30, 30]]),
      [
        'diff --git a/packages/verify/vitest.config.ts b/packages/verify/vitest.config.ts',
        '+++ b/packages/verify/vitest.config.ts',
        '@@ -22 +22 @@',
        '+        lines: 31,',
        '',
      ].join('\n'),
    ].join('');
    assert.equal(evaluateCoverageRatchet(diff).notify, false);
  });

  it('ignores lines other than the four floor metrics (autoUpdate, comments, other thresholds)', () => {
    const diff = [
      'diff --git a/packages/editor/vitest.config.ts b/packages/editor/vitest.config.ts',
      '+++ b/packages/editor/vitest.config.ts',
      '@@ -19 +19 @@',
      '-        autoUpdate: false,',
      '+        autoUpdate: true,',
      '@@ -26 +26 @@',
      '-        perFile: false,',
      '+        perFile: true,',
      '',
    ].join('\n');
    assert.deepEqual(parseFloorChanges(diff), []);
  });

  it('ignores a diff of a file that is not a package vitest.config.ts', () => {
    const diff = [
      'diff --git a/scripts/other.mjs b/scripts/other.mjs',
      '+++ b/scripts/other.mjs',
      '@@ -1 +1 @@',
      '-        lines: 1,',
      '+        lines: 9,',
      '',
    ].join('\n');
    assert.deepEqual(parseFloorChanges(diff), []);
  });

  it('does not attribute floor lines after a non-package file header to the previous package', () => {
    const diff =
      fileDiff('editor', [['lines', 30, 32]]) +
      [
        'diff --git a/docs/sample.ts b/docs/sample.ts',
        '+++ b/docs/sample.ts',
        '@@ -3 +3 @@',
        '-        branches: 1,',
        '+        branches: 9,',
        '',
      ].join('\n');
    assert.deepEqual(parseFloorChanges(diff), [{ pkg: 'editor', metric: 'lines', from: 30, to: 32 }]);
  });

  it('reports only the raised metrics when a package has both a raise and a drop', () => {
    const result = evaluateCoverageRatchet(
      fileDiff('workers', [
        ['lines', 94, 96],
        ['functions', 95, 94],
      ])
    );
    assert.deepEqual(result.raises, [{ pkg: 'workers', metric: 'lines', from: 94, to: 96 }]);
    assert.equal(result.count, 1);
  });
});

describe('formatIssueBody', () => {
  const raises = [
    { pkg: 'editor', metric: 'branches', from: 21, to: 23 },
    { pkg: 'shared', metric: 'lines', from: 78, to: 80 },
  ];

  it('lists every raise as a table row with the package, metric and current → raisable value', () => {
    const body = formatIssueBody(raises);
    assert.match(body, /\| `editor` \| `branches` \| 21 → 23 \|/);
    assert.match(body, /\| `shared` \| `lines` \| 78 → 80 \|/);
  });

  it('starts with the summary and the decision line the issue convention requires', () => {
    const body = formatIssueBody(raises);
    assert.match(body.split('\n')[0], /^\*\*要約\*\*:.*2 パッケージ・2 指標/);
    assert.match(body.split('\n')[2], /^\*\*人が判断すること\*\*:/);
  });

  it('links the run and the commit when the context is given', () => {
    const body = formatIssueBody(raises, { sha: 'abc123', repo: 'o/r', runId: '42' });
    assert.match(body, /`abc123`/);
    assert.match(body, /https:\/\/github\.com\/o\/r\/actions\/runs\/42/);
  });

  it('uses the title that the workflow matches on to append to an existing issue', () => {
    assert.equal(ISSUE_TITLE, 'chore: カバレッジの床を上げられる (自動)');
  });
});
