/**
 * scripts/claim-stall.mjs (着手印の放置の検出 / #469) の判定ロジックの検証。
 *
 * ルートに vitest の設定が無いので node:test で書く。実行: `node --test scripts/claim-stall.test.mjs`
 * (`npm run check:fast` の `node --test 'scripts/*.test.mjs'` に自動で乗る)。
 * gh を呼ぶ CLI 部分は入出力の配線だけなので、判定の純関数と GraphQL 応答の整形・要約の組み立てを検証する。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CLAIM_LABEL,
  REMEDIES,
  buildQuery,
  evaluateClaimStall,
  formatSummary,
  mentionsIssue,
  normalizeClaimData,
} from './claim-stall.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-03T00:00:00Z');

/** now から `days` 日前の ISO 文字列。 */
function ago(days) {
  return new Date(NOW.getTime() - days * DAY).toISOString();
}

/** 印付きの open Issue。最後の動きは `days` 日前 (窓の中なら、その動きを人の手として持たせる)。 */
function claimed(number, days, extra = {}) {
  const updatedAt = ago(days);
  return {
    number,
    title: `issue ${number}`,
    state: 'OPEN',
    labels: [CLAIM_LABEL],
    updatedAt,
    lastEditedAt: null,
    windowItems: days <= 3 ? [{ actorType: 'User', createdAt: updatedAt }] : [],
    ...extra,
  };
}

function judge(issues, openPrs = [], thresholdDays) {
  return evaluateClaimStall({ issues, openPrs, now: NOW, thresholdDays });
}

const stalledNumbers = (result) => result.stalled.map((issue) => issue.number);

describe('evaluateClaimStall (Issue #469 の 3 例)', () => {
  it('detects a claimed issue with no open PR whose last human hand was 4 days ago', () => {
    const result = judge([claimed(10, 4)]);
    assert.deepEqual(stalledNumbers(result), [10]);
    assert.equal(result.stalled[0].botOnly, false);
  });

  it('does not detect a claimed issue that an open PR closes', () => {
    const result = judge([claimed(10, 4)], [{ number: 99, body: '', closingIssues: [10] }]);
    assert.deepEqual(stalledNumbers(result), []);
  });

  it('does not detect a claimed issue whose last human hand was 1 day ago', () => {
    assert.deepEqual(stalledNumbers(judge([claimed(10, 1)])), []);
  });
});

describe('threshold boundary (#469)', () => {
  it('does not detect at exactly 3 days (the threshold is exceeded, not reached)', () => {
    const issue = claimed(10, 3);
    assert.deepEqual(stalledNumbers(judge([issue])), []);
  });

  it('detects as soon as the last hand is older than the threshold, without rounding to whole days', () => {
    const issue = { ...claimed(10, 4), updatedAt: new Date(NOW.getTime() - 3 * DAY - 1).toISOString() };
    assert.deepEqual(stalledNumbers(judge([issue])), [10]);
  });

  it('detects any claimed issue that is not moving right now when the threshold is 0 days', () => {
    assert.deepEqual(stalledNumbers(judge([claimed(10, 0.01)], [], 0)), [10]);
  });

  it('honors a custom thresholdDays', () => {
    assert.deepEqual(stalledNumbers(judge([claimed(10, 4)], [], 7)), []);
    assert.deepEqual(stalledNumbers(judge([claimed(10, 8)], [], 7)), [10]);
  });

  it('rejects a negative thresholdDays', () => {
    assert.throws(() => judge([], [], -1), /thresholdDays/);
  });
});

describe('open PR references (#469)', () => {
  it('counts a #N mention in the PR body as a reference', () => {
    const result = judge([claimed(10, 4)], [{ number: 99, body: 'Refs #10 の続き', closingIssues: [] }]);
    assert.deepEqual(stalledNumbers(result), []);
  });

  it('does not let #3 in a PR body match issue #346', () => {
    const result = judge([claimed(346, 4)], [{ number: 99, body: 'Closes #3', closingIssues: [3] }]);
    assert.deepEqual(stalledNumbers(result), [346]);
  });

  it('matches #N only on word boundaries and not as a cross-repo reference', () => {
    assert.equal(mentionsIssue('Closes #3.', 3), true);
    assert.equal(mentionsIssue('(#3)', 3), true);
    assert.equal(mentionsIssue('#346', 3), false);
    assert.equal(mentionsIssue('#3a', 3), false);
    assert.equal(mentionsIssue('other/repo#3', 3), false);
    assert.equal(mentionsIssue('##3', 3), false);
    assert.equal(mentionsIssue(null, 3), false);
  });
});

describe('human hand vs bot hand in the window (#469)', () => {
  it('detects an issue whose window holds only bot hands', () => {
    const issue = claimed(10, 1, { windowItems: [{ actorType: 'Bot', createdAt: ago(1) }] });
    const result = judge([issue]);
    assert.deepEqual(stalledNumbers(result), [10]);
    assert.equal(result.stalled[0].botOnly, true);
  });

  it('does not detect an issue whose window holds a human comment among bot hands', () => {
    const issue = claimed(10, 1, {
      windowItems: [
        { actorType: 'Bot', createdAt: ago(1) },
        { actorType: 'User', createdAt: ago(2) },
      ],
    });
    assert.deepEqual(stalledNumbers(judge([issue])), []);
  });

  it('treats an item whose author cannot be read as a human hand', () => {
    const issue = claimed(10, 1, { windowItems: [{ actorType: 'Bot' }, { actorType: null }] });
    assert.deepEqual(stalledNumbers(judge([issue])), []);
  });

  it('treats a recent updatedAt with an empty window as moving', () => {
    const issue = claimed(10, 1, { windowItems: [] });
    assert.deepEqual(stalledNumbers(judge([issue])), []);
  });

  it('treats a window with more items than were fetched as moving', () => {
    const issue = claimed(10, 1, { windowItems: [{ actorType: 'Bot' }], windowTotal: 2 });
    assert.deepEqual(stalledNumbers(judge([issue])), []);
  });

  it('treats a body edit inside the window as moving even when the timeline holds only bot hands', () => {
    const issue = claimed(10, 1, { lastEditedAt: ago(2), windowItems: [{ actorType: 'Bot' }] });
    assert.deepEqual(stalledNumbers(judge([issue])), []);
  });

  it('ignores a human hand that is older than the window', () => {
    const issue = claimed(10, 1, {
      windowItems: [
        { actorType: 'Bot', createdAt: ago(1) },
        { actorType: 'User', createdAt: ago(5) },
      ],
    });
    assert.deepEqual(stalledNumbers(judge([issue])), [10]);
  });
});

describe('sub-issues (one level only) (#469)', () => {
  it('does not detect a tracking issue whose sub-issue has an open PR', () => {
    const parent = claimed(1, 10, { subIssues: [claimed(2, 10)] });
    const result = judge([parent], [{ number: 99, body: '', closingIssues: [2] }]);
    assert.deepEqual(stalledNumbers(result), []);
  });

  it('does not detect a tracking issue whose sub-issue moved by a human hand in the window', () => {
    const parent = claimed(1, 10, { subIssues: [claimed(2, 1)] });
    assert.deepEqual(stalledNumbers(judge([parent])), []);
  });

  it('detects a tracking issue whose sub-issues are all quiet', () => {
    const quietChild = claimed(3, 1, { windowItems: [{ actorType: 'Bot' }] });
    const parent = claimed(1, 10, { subIssues: [claimed(2, 10), quietChild] });
    assert.deepEqual(stalledNumbers(judge([parent])), [1]);
  });

  it('does not look at grandchildren', () => {
    const parent = claimed(1, 10, { subIssues: [claimed(2, 10, { subIssues: [claimed(3, 1)] })] });
    assert.deepEqual(stalledNumbers(judge([parent])), [1]);
  });
});

describe('scope (#469)', () => {
  it('ignores issues without the claim label', () => {
    const issue = { ...claimed(10, 30), labels: ['enhancement'] };
    const result = judge([issue]);
    assert.deepEqual(stalledNumbers(result), []);
    assert.equal(result.checked, 0);
  });

  it('ignores closed issues', () => {
    assert.deepEqual(stalledNumbers(judge([{ ...claimed(10, 30), state: 'CLOSED' }])), []);
  });
});

describe('normalizeClaimData (#469)', () => {
  const issueNode = (extra = {}) => ({
    number: 10,
    title: 't',
    state: 'OPEN',
    updatedAt: ago(1),
    lastEditedAt: null,
    labels: { nodes: [{ name: CLAIM_LABEL }] },
    timelineItems: {
      filteredCount: 2,
      nodes: [
        { __typename: 'IssueComment', createdAt: ago(1), author: { __typename: 'Bot' } },
        { __typename: 'SomeUnknownEvent' },
      ],
    },
    subIssues: { pageInfo: { hasNextPage: false }, nodes: [] },
    ...extra,
  });
  const response = (issues, prs = [], more = {}) => ({
    data: {
      repository: {
        issues: { pageInfo: { hasNextPage: more.issues ?? false }, nodes: issues },
        pullRequests: { pageInfo: { hasNextPage: more.prs ?? false }, nodes: prs },
      },
    },
  });

  it('maps timeline authors and actors to actor types and unknown items to null', () => {
    const { issues } = normalizeClaimData(response([issueNode()]));
    assert.deepEqual(issues[0].windowItems, [
      { actorType: 'Bot', createdAt: ago(1) },
      { actorType: null, createdAt: null },
    ]);
    assert.equal(issues[0].windowTotal, 2);
    assert.deepEqual(issues[0].labels, [CLAIM_LABEL]);
  });

  it('maps closingIssuesReferences of open PRs to issue numbers', () => {
    const pr = { number: 99, body: 'b', closingIssuesReferences: { nodes: [{ number: 10 }] } };
    const { openPrs } = normalizeClaimData(response([], [pr]));
    assert.deepEqual(openPrs, [{ number: 99, body: 'b', closingIssues: [10] }]);
  });

  it('refuses a response that has more pages instead of judging on partial input', () => {
    assert.throws(() => normalizeClaimData(response([], [], { issues: true })), /取りこぼし/);
    assert.throws(() => normalizeClaimData(response([], [], { prs: true })), /取りこぼし/);
    const parent = issueNode({ subIssues: { pageInfo: { hasNextPage: true }, nodes: [] } });
    assert.throws(() => normalizeClaimData(response([parent])), /取りこぼし/);
  });

  it('refuses a response with GraphQL errors', () => {
    assert.throws(() => normalizeClaimData({ errors: [{ message: 'boom' }] }), /boom/);
  });
});

describe('buildQuery / formatSummary (#469)', () => {
  it('asks only for the claim-labelled open issues within the window', () => {
    const query = buildQuery();
    assert.match(query, /issues\(labels: \[\$label\], states: OPEN/);
    assert.match(query, /timelineItems\(since: \$since/);
    assert.doesNotMatch(query, /ProjectV2/);
  });

  it('lists each stalled issue with its remedies', () => {
    const result = judge([claimed(10, 4)]);
    const summary = formatSummary(result, { repo: 'o/r' });
    assert.match(summary, /\[#10\]\(https:\/\/github\.com\/o\/r\/issues\/10\)/);
    for (const remedy of REMEDIES) assert.ok(summary.includes(remedy));
  });

  it('states zero findings without remedies when nothing is stalled', () => {
    const summary = formatSummary(judge([claimed(10, 1)]));
    assert.match(summary, /\*\*0 件\*\*/);
    assert.ok(!summary.includes(REMEDIES[0]));
  });
});
