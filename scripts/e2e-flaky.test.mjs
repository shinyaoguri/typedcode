/**
 * scripts/e2e-flaky.mjs (E2E の flaky の収集 / #583) の判定と本文の組み立ての検証。
 *
 * ルートに vitest の設定が無いので node:test で書く。実行: `node --test scripts/e2e-flaky.test.mjs`
 * (`npm run check:fast` の `node --test 'scripts/*.test.mjs'` に自動で乗る)。
 * ファイルの読み込みと gh を呼ぶ CLI 部分は入出力の配線だけなので、純関数を検証する。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ERROR_MAX_CHARS,
  ERROR_MAX_LINES,
  codeSpan,
  collectFlaky,
  errorHead,
  formatIssueComment,
  formatSummary,
  isFlaky,
  markerOf,
  mergeReports,
  unreported,
} from './e2e-flaky.mjs';

const ESC = String.fromCharCode(27);

/** JSONReportTest。results は status の並び (1 回目のエラーは message で渡す)。 */
function test(statuses, { status, message = 'Error: boom' } = {}) {
  return {
    projectName: 'chromium',
    expectedStatus: 'passed',
    ...(status === undefined ? {} : { status }),
    results: statuses.map((s, retry) => ({
      status: s,
      retry,
      ...(s === 'passed' ? {} : { error: { message: `${message} (retry ${retry})` } }),
    })),
  };
}

/** 1 ファイル・1 describe の JSON レポート。 */
function report(specs, { file = 'fault-storage.spec.ts' } = {}) {
  return {
    suites: [
      {
        title: file,
        file,
        specs: [],
        suites: [
          {
            title: 'storage',
            file,
            specs: specs.map(([title, line, tests]) => ({ title, file, line, tests })),
          },
        ],
      },
    ],
  };
}

const FLAKY = test(['failed', 'passed'], { status: 'flaky' });
const PASSED = test(['passed'], { status: 'expected' });
const FAILED = test(['failed', 'failed'], { status: 'unexpected' });

describe('isFlaky', () => {
  it('trusts the Playwright status and never counts a finally failed test as flaky', () => {
    assert.equal(isFlaky(FLAKY), true);
    assert.equal(isFlaky(PASSED), false);
    assert.equal(isFlaky(FAILED), false);
  });

  it('falls back to the result order (unexpected then expected) when the report has no status', () => {
    assert.equal(isFlaky(test(['failed', 'passed'])), true);
    assert.equal(isFlaky(test(['timedOut', 'passed'])), true);
    assert.equal(isFlaky(test(['passed'])), false);
    assert.equal(isFlaky(test(['passed', 'failed'])), false);
    assert.equal(isFlaky(test(['failed', 'failed'])), false);
  });
});

describe('collectFlaky', () => {
  it('returns nothing for a report with zero flaky tests', () => {
    assert.deepEqual(
      collectFlaky(
        report([
          ['ok', 10, [PASSED]],
          ['broken', 20, [FAILED]],
        ]),
        'e2e'
      ),
      []
    );
  });

  it('names the flaky test by its describe path, location and the first attempt error', () => {
    const [flaky] = collectFlaky(report([['quota', 101, [FLAKY]]]), 'e2e');
    assert.equal(flaky.title, 'storage › quota');
    assert.equal(flaky.file, 'fault-storage.spec.ts');
    assert.equal(flaky.line, 101);
    assert.equal(flaky.config, 'e2e');
    assert.equal(flaky.attempts, 2);
    assert.equal(flaky.firstError, 'Error: boom (retry 0)');
  });

  it('takes the error of the first failed attempt, not of a later failed retry', () => {
    const twice = test(['skipped', 'failed', 'timedOut', 'passed'], { status: 'flaky' });
    const [flaky] = collectFlaky(report([['quota', 101, [twice]]]), 'e2e');
    assert.equal(flaky.firstError, 'Error: boom (retry 1)');
  });

  it('rejects something that is not a Playwright JSON report', () => {
    assert.throws(() => collectFlaky({ nope: true }, 'e2e'), /suites/);
    assert.throws(() => collectFlaky(null, 'e2e'), /suites/);
  });
});

describe('errorHead', () => {
  it('strips ANSI escapes from the error text', () => {
    assert.equal(
      errorHead(`${ESC}[31mError:${ESC}[39m expected ${ESC}[2maborted${ESC}[22m`),
      'Error: expected aborted'
    );
  });

  it('cuts the error to the first lines and characters and marks the cut', () => {
    const many = Array.from({ length: ERROR_MAX_LINES + 5 }, (_, i) => `line ${i}`).join('\n');
    const head = errorHead(many);
    assert.equal(head.split('\n').length, ERROR_MAX_LINES + 1);
    assert.ok(head.endsWith('\n…'));
    assert.ok(errorHead('x'.repeat(ERROR_MAX_CHARS * 2)).length <= ERROR_MAX_CHARS + 2);
    assert.equal(errorHead('short'), 'short');
  });
});

describe('mergeReports', () => {
  it('reports the same test once when several shards or reruns list it', () => {
    const one = report([['quota', 101, [FLAKY]]]);
    const { flaky, problems } = mergeReports([
      { config: 'e2e', report: one, source: 'shard-1/e2e.json' },
      { config: 'e2e', report: one, source: 'shard-2/e2e.json' },
    ]);
    assert.equal(flaky.length, 1);
    assert.deepEqual(problems, []);
  });

  it('keeps the same test of the dev and build configs apart', () => {
    const one = report([['quota', 101, [FLAKY]]]);
    const { flaky } = mergeReports([
      { config: 'e2e', report: one },
      { config: 'e2e-build', report: one },
    ]);
    assert.deepEqual(flaky.map((f) => f.config).sort(), ['e2e', 'e2e-build']);
  });

  it('turns a broken report into a problem instead of throwing, and keeps the readable ones', () => {
    const { flaky, problems } = mergeReports([
      { config: 'e2e', report: 'garbage', source: 'shard-1/e2e.json' },
      { config: 'e2e', report: report([['quota', 101, [FLAKY]]]), source: 'shard-2/e2e.json' },
    ]);
    assert.equal(flaky.length, 1);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].source, 'shard-1/e2e.json');
  });
});

describe('formatSummary', () => {
  it('says there is nothing when no test was flaky', () => {
    const md = formatSummary({ flaky: [], problems: [] }, { label: 'shard 1/2' });
    assert.match(md, /^## E2E の flaky \(shard 1\/2\)/);
    assert.match(md, /retry で通ったテストは無い/);
  });

  it('lists every flaky test with its location and error', () => {
    const { flaky } = mergeReports([{ config: 'e2e', report: report([['quota', 101, [FLAKY]]]) }]);
    const md = formatSummary({ flaky, problems: [] });
    assert.match(md, /\*\*1 件\*\*/);
    assert.match(md, /`storage › quota`/);
    assert.match(md, /`fault-storage\.spec\.ts:101`/);
    assert.match(md, /```\nError: boom \(retry 0\)\n```/);
  });

  it('says the report is missing or broken without listing any flaky test', () => {
    const md = formatSummary({
      flaky: [],
      problems: [{ source: 'packages/e2e/reports', reason: 'レポートのディレクトリが無い' }],
    });
    assert.match(md, /集められなかったレポート/);
    assert.match(md, /`packages\/e2e\/reports`: レポートのディレクトリが無い/);
    assert.doesNotMatch(md, /^retry で通ったテストは無い/m);
  });
});

describe('formatIssueComment', () => {
  const context = {
    runId: '41771700855',
    runUrl: 'https://github.com/o/r/actions/runs/41771700855/attempts/1',
    sha: 'abc',
  };

  it('does nothing when there is no flaky test', () => {
    assert.equal(formatIssueComment([], context), null);
  });

  it('carries the run URL, the test name and a marker per test', () => {
    const { flaky } = mergeReports([{ config: 'e2e', report: report([['quota', 101, [FLAKY]]]) }]);
    const body = formatIssueComment(flaky, context);
    assert.ok(body.includes(context.runUrl));
    assert.ok(body.includes('`storage › quota`'));
    assert.ok(body.includes(markerOf(context.runId, flaky[0].key)));
  });

  it('keeps mentions and issue references of the error and title inside code', () => {
    const tricky = test(['failed', 'passed'], { status: 'flaky', message: 'Error: see #569 and ask @someone ```' });
    const { flaky } = mergeReports([{ config: 'e2e', report: report([['#552 quota @x', 101, [tricky]]]) }]);
    const body = formatIssueComment(flaky, context);
    // コードの外に出た行に `#数字` や `@名前` が残っていない
    const outside = body
      .replace(/(`{3,})\n[\s\S]*?\n\1/g, '')
      .replace(/(`+) ?[^`]*? ?\1/g, '')
      .replace(/<!--[\s\S]*?-->/g, '');
    assert.doesNotMatch(outside, /#\d/);
    assert.doesNotMatch(outside, /@\w/);
    // エラー文言のバッククォートでコードブロックが閉じない (外側のフェンスがより長い)
    assert.match(body, /````\nError: see #569 and ask @someone ``` \(retry 0\)\n````/);
  });
});

describe('unreported', () => {
  it('skips tests already reported for the same run, so a re-run does not append them twice', () => {
    const { flaky } = mergeReports([
      {
        config: 'e2e',
        report: report([
          ['quota', 101, [FLAKY]],
          ['abort', 130, [FLAKY]],
        ]),
      },
    ]);
    const posted = formatIssueComment([flaky[0]], { runId: '7', runUrl: 'u' });
    assert.deepEqual(
      unreported(flaky, '7', ['issue body', posted]).map((f) => f.key),
      [flaky[1].key]
    );
  });

  it('reports the same test again for a different run', () => {
    const { flaky } = mergeReports([{ config: 'e2e', report: report([['quota', 101, [FLAKY]]]) }]);
    const posted = formatIssueComment(flaky, { runId: '7', runUrl: 'u' });
    assert.equal(unreported(flaky, '8', [posted]).length, 1);
  });
});

describe('codeSpan', () => {
  it('uses a longer fence than any backtick run inside', () => {
    assert.equal(codeSpan('a`b'), '``a`b``');
    assert.equal(codeSpan('`x'), '`` `x ``');
  });
});
