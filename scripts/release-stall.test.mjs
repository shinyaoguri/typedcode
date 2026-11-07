/**
 * scripts/release-stall.mjs (本番リリースの停滞検知 / #410) の判定ロジックの検証。
 *
 * ルートに vitest の設定が無いので node:test で書く。実行: `node --test scripts/release-stall.test.mjs`
 * (`npm run check:fast` の `node --test 'scripts/*.test.mjs'` に自動で乗る)。
 * git を呼ぶ CLI 部分は入出力の配線だけなので、判定の純関数と Issue 本文の組み立てを検証する。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ISSUE_TITLE,
  RELEASE_SUBJECT,
  STALL_THRESHOLD_DAYS,
  evaluateReleaseStall,
  formatIssueBody,
} from './release-stall.mjs';

const DAY = 24 * 60 * 60 * 1000;
const TAG_DATE = new Date('2026-07-07T00:00:00Z');

/** タグから `days` 日 (と `extraMs` ミリ秒) 後を now にして判定する。 */
function judge(days, subjects, extraMs = 0) {
  return evaluateReleaseStall({
    tagDate: TAG_DATE,
    now: new Date(TAG_DATE.getTime() + days * DAY + extraMs),
    subjects,
  });
}

describe('evaluateReleaseStall (Issue #410 の 4 例を、#657 の 7 日に読み替えたもの)', () => {
  it('detects when 8 days have passed since the tag and there is 1 fix', () => {
    const result = judge(8, ['fix(editor): バグを直す (#1)']);
    assert.equal(result.stalled, true);
    assert.equal(result.days, 8);
    assert.equal(result.count, 1);
  });

  it('does not detect when 8 days have passed but only docs / chore commits exist', () => {
    const result = judge(8, ['docs: 追記', 'chore(deps): bump', 'ci: 直す', 'refactor(shared): 整理', 'test: 足す']);
    assert.equal(result.stalled, false);
    assert.equal(result.count, 0);
  });

  it('does not detect when only 6 days have passed even with 5 fixes', () => {
    const result = judge(6, ['fix: a', 'fix: b', 'fix: c', 'fix: d', 'fix: e']);
    assert.equal(result.stalled, false);
    assert.equal(result.count, 5);
  });

  it('counts a breaking feat(editor)!: commit', () => {
    const result = judge(8, ['feat(editor)!: 形式を変える (#2)']);
    assert.equal(result.count, 1);
    assert.deepEqual(result.matches, ['feat(editor)!: 形式を変える (#2)']);
    assert.equal(result.stalled, true);
  });
});

describe('threshold boundary', () => {
  it('defaults to 7 days (#657)', () => {
    assert.equal(STALL_THRESHOLD_DAYS, 7);
    assert.equal(judge(0, []).thresholdDays, 7);
  });

  it('does not detect at exactly 7 days (the threshold is exceeded, not reached)', () => {
    assert.equal(judge(7, ['fix: a']).stalled, false);
  });

  it('does not detect at 7 days and 23 hours (whole elapsed days are counted)', () => {
    const result = judge(7, ['fix: a'], 23 * 60 * 60 * 1000);
    assert.equal(result.days, 7);
    assert.equal(result.stalled, false);
  });

  it('detects as soon as 8 whole days have elapsed', () => {
    assert.equal(judge(8, ['fix: a']).stalled, true);
  });

  it('honors a custom thresholdDays', () => {
    const result = evaluateReleaseStall({
      tagDate: TAG_DATE,
      now: new Date(TAG_DATE.getTime() + 8 * DAY),
      subjects: ['fix: a'],
      thresholdDays: 30,
    });
    assert.equal(result.stalled, false);
  });

  it('does not detect when there are no commits at all, however old the tag is', () => {
    assert.equal(judge(300, []).stalled, false);
  });

  it('rejects an unreadable date instead of silently passing', () => {
    assert.throws(() => evaluateReleaseStall({ tagDate: 'nope', now: new Date(), subjects: [] }), /日時/);
  });
});

describe('RELEASE_SUBJECT', () => {
  it('matches fix / feat with an optional scope and breaking mark', () => {
    for (const subject of ['fix: a', 'feat: a', 'fix(deps): a', 'feat(editor)!: a', 'fix!: a']) {
      assert.equal(RELEASE_SUBJECT.test(subject), true, subject);
    }
  });

  it('does not match other types, lookalikes, or a missing colon', () => {
    for (const subject of [
      'docs: a',
      'chore(deps): a',
      'perf: a',
      'fixup: a',
      'prefix: a',
      'Fix: a',
      'fix a',
      'Merge branch fix: x',
    ]) {
      assert.equal(RELEASE_SUBJECT.test(subject), false, subject);
    }
  });
});

describe('formatIssueBody', () => {
  const result = judge(117, ['fix(editor): a (#1)', 'feat(verify)!: b (#2)']);
  const body = formatIssueBody(result, {
    tag: 'v1.1.0',
    tagDate: TAG_DATE,
    sha: 'abc1234',
    repo: 'owner/repo',
    runId: '42',
  });

  it('states the tag, elapsed days, count, and lists the commits', () => {
    assert.match(body, /v1\.1\.0/);
    assert.match(body, /2026-07-07/);
    assert.match(body, /117 日/);
    assert.match(body, /2 件/);
    assert.match(body, /- fix\(editor\): a \(#1\)/);
    assert.match(body, /- feat\(verify\)!: b \(#2\)/);
  });

  it('links to the release section of CONTRIBUTING.md and to the run', () => {
    assert.match(body, /\(https:\/\/github\.com\/owner\/repo\/blob\/main\/CONTRIBUTING\.md#リリース-v-タグ\)/);
    assert.match(body, /\/actions\/runs\/42/);
  });

  it('caps the listed commits and says how many were left out', () => {
    const many = Array.from({ length: 130 }, (_, i) => `fix: item ${i}`);
    const capped = formatIssueBody(judge(40, many), { tag: 'v1.1.0', tagDate: TAG_DATE });
    assert.match(capped, /ほか 30 件/);
    assert.doesNotMatch(capped, /fix: item 100\b/);
  });

  it('keeps the title a stable, dedicated one', () => {
    assert.equal(ISSUE_TITLE, 'chore: 本番リリースの停滞 (自動)');
  });
});
