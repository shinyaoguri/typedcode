/**
 * scripts/release.mjs (changelog.d の断片から Release ノートを組む・断片を検査する。#842 / 次の beta 版と
 * 打つコミットを決める。#843 / ADR-0055) の検証。
 * 実行: `node --test scripts/release.test.mjs` (CI は check job が scripts/*.test.mjs を回す)。
 *
 * notes と beta の git の扱い (前回のタグ・追加された断片・断片を足したコミットの除外・タグ以降のコミット) は、
 * 使い捨ての git リポジトリを組み立てて CLI を実際に打って確かめる。beta が読む Deploy の run は
 * RELEASE_DEPLOY_RUNS_FILE で差し替える。末尾で deploy.yml と release.yml の条件も固定する。
 */

import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildReleaseNotes,
  cycleFor,
  EMPTY_NOTES,
  EXIT_SKIP,
  isReleaseSubject,
  jstYearMonth,
  lintFragments,
  nextBetaVersion,
  pickVerifiedCommit,
  planBeta,
  verifiedShasFromRuns,
} from './release.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'release.mjs');

describe('buildReleaseNotes', () => {
  it('orders sections as breaking, feature, fix, perf, docs and omits empty ones', () => {
    const notes = buildReleaseNotes({
      fragments: [
        { name: 'b.docs.md', body: 'docs item' },
        { name: 'a.fix.md', body: 'fix item' },
        { name: 'c.breaking.md', body: 'breaking item' },
      ],
      commits: [{ subject: 'feat(editor): new thing', addedFragments: [] }],
    });
    assert.equal(
      notes,
      [
        '## 破壊的変更',
        '',
        '- breaking item',
        '',
        '## 新機能',
        '',
        '- feat(editor): new thing',
        '',
        '## 修正',
        '',
        '- fix item',
        '',
        '## ドキュメント',
        '',
        '- docs item',
        '',
      ].join('\n')
    );
  });

  it('lists fragments by name before commit subjects (oldest first) within a section', () => {
    const notes = buildReleaseNotes({
      fragments: [
        { name: 'zeta.fix.md', body: 'zeta' },
        { name: 'alpha.fix.md', body: 'alpha' },
      ],
      commits: [
        { subject: 'fix: older', addedFragments: [] },
        { subject: 'fix: newer', addedFragments: [] },
      ],
    });
    assert.equal(notes, '## 修正\n\n- alpha\n- zeta\n- fix: older\n- fix: newer\n');
  });

  it('keeps a multi-paragraph fragment inside one bullet item by indenting the following lines', () => {
    const notes = buildReleaseNotes({
      fragments: [{ name: 'x.breaking.md', body: 'First line.\nSecond line.\n\nMigration:\n1. do this\n' }],
      commits: [],
    });
    assert.equal(notes, '## 破壊的変更\n\n- First line.\n  Second line.\n\n  Migration:\n  1. do this\n');
  });

  it('drops HTML comments from fragment bodies', () => {
    const notes = buildReleaseNotes({
      fragments: [{ name: 'x.fix.md', body: '<!-- 書き方のメモ -->\nVisible text.<!-- inline -->\n' }],
      commits: [],
    });
    assert.equal(notes, '## 修正\n\n- Visible text.\n');
  });

  it('prints the single no-change line when there is no section', () => {
    const notes = buildReleaseNotes({
      fragments: [],
      commits: [
        { subject: 'docs: update', addedFragments: [] },
        { subject: 'chore: tidy', addedFragments: [] },
      ],
    });
    assert.equal(notes, `${EMPTY_NOTES}\n`);
  });

  it('puts a breaking (!) commit without a fragment into the breaking section', () => {
    const notes = buildReleaseNotes({
      fragments: [],
      commits: [{ subject: 'feat(editor)!: drop x', addedFragments: [] }],
    });
    assert.equal(notes, '## 破壊的変更\n\n- feat(editor)!: drop x\n');
  });

  it('omits the subject of a commit that added a fragment', () => {
    const notes = buildReleaseNotes({
      fragments: [{ name: 'tab.fix.md', body: 'Tab names fixed.' }],
      commits: [{ subject: 'fix: tab name', addedFragments: ['changelog.d/tab.fix.md'] }],
    });
    assert.equal(notes, '## 修正\n\n- Tab names fixed.\n');
  });
});

describe('isReleaseSubject', () => {
  for (const subject of ['fix: x', 'feat(editor): x', 'feat(editor)!: x']) {
    it(`treats "${subject}" as a user-facing change`, () => {
      assert.equal(isReleaseSubject(subject), true);
    });
  }
  for (const subject of ['docs: x', 'chore: x', 'ci: x', 'refactor: x']) {
    it(`does not treat "${subject}" as a user-facing change`, () => {
      assert.equal(isReleaseSubject(subject), false);
    });
  }
});

describe('lintFragments', () => {
  const file = (name, body = 'Some change.') => ({ name, isDirectory: false, body });

  for (const name of ['Bad Name.md', 'UPPER.fix.md', 'thing.unknown.md']) {
    it(`reports a fragment whose name does not match the form: ${name}`, () => {
      assert.deepEqual(
        lintFragments([file(name)]).map((p) => p.name),
        [name]
      );
    });
  }

  it('reports an empty fragment', () => {
    assert.deepEqual(
      lintFragments([file('empty.fix.md', '  \n')]).map((p) => p.name),
      ['empty.fix.md']
    );
  });

  it('reports a fragment that holds only an HTML comment', () => {
    assert.deepEqual(
      lintFragments([file('comment.fix.md', '<!-- todo -->\n')]).map((p) => p.name),
      ['comment.fix.md']
    );
  });

  it('passes a well-formed fragment, README.md and a subdirectory', () => {
    assert.deepEqual(
      lintFragments([
        file('fix-tab-name.fix.md'),
        file('a1-b2.breaking.md'),
        file('README.md', ''),
        { name: 'Archive Dir', isDirectory: true },
      ]),
      []
    );
  });
});

describe('release.mjs lint (CLI)', () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'release-lint-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('exits 0 when changelog.d does not exist', () => {
    const result = spawnSync(process.execPath, [SCRIPT, 'lint'], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0);
  });

  it('exits 1 and names the file when a fragment is malformed, ignoring files in subdirectories', () => {
    mkdirSync(join(dir, 'changelog.d', 'old'), { recursive: true });
    writeFileSync(join(dir, 'changelog.d', 'old', 'Whatever.txt'), '');
    writeFileSync(join(dir, 'changelog.d', 'good.fix.md'), 'Fixed.\n');
    writeFileSync(join(dir, 'changelog.d', 'Bad Name.md'), 'x\n');
    const result = spawnSync(process.execPath, [SCRIPT, 'lint'], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Bad Name\.md/);
    assert.doesNotMatch(result.stderr, /good\.fix\.md|Whatever/);
  });
});

/** 使い捨ての git リポジトリの足場 (notes と beta の CLI の結合テストが使う)。 */
function throwawayRepo(prefix) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  const commit = (subject, files = {}) => {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), body);
    }
    git('add', '-A');
    git('commit', '--allow-empty', '-q', '-m', subject);
    return git('rev-parse', 'HEAD').trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release-test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  return { repo, git, commit };
}

describe('release.mjs notes (CLI on a throwaway git repository)', () => {
  let repo;
  let git;
  let commit;
  const notes = (...args) => spawnSync(process.execPath, [SCRIPT, 'notes', ...args], { cwd: repo, encoding: 'utf8' });

  before(() => {
    ({ repo, git, commit } = throwawayRepo('release-notes-'));
    commit('chore: init', { 'README.md': 'repo\n' });
    commit('fix: old thing', { 'changelog.d/old-thing.fix.md': 'Old thing body.\n' });
    git('tag', 'v1.0.0');
    // タグより前の断片を後から書き直しても、追加ではないので今回のノートには載らない
    commit('docs: reword old fragment', { 'changelog.d/old-thing.fix.md': 'Old thing body, reworded.\n' });
    commit('fix: tab name subject', { 'changelog.d/fix-tab-name.fix.md': 'Tab name body.\n' });
    commit('feat(editor): 何か');
  });
  after(() => rmSync(repo, { recursive: true, force: true }));

  it('builds notes from fragments added since the nearest v* tag and fix / feat commits without fragments', () => {
    const result = notes();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '## 新機能\n\n- feat(editor): 何か\n\n## 修正\n\n- Tab name body.\n');
    assert.doesNotMatch(result.stdout, /Old thing body/);
    assert.doesNotMatch(result.stdout, /fix: tab name subject/);
  });

  it('uses --since instead of the nearest tag', () => {
    const since = git('rev-list', '--max-parents=0', 'HEAD').trim();
    const result = notes('--since', since);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Old thing body/);
    assert.match(result.stdout, /Tab name body/);
  });

  it('exits 1 with a reason when no v* tag is reachable and --since is not given', () => {
    const first = git('rev-list', '--max-parents=0', 'HEAD').trim();
    const result = notes('--to', first);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /v\* タグが無い/);
  });
});

// ---------------------------------------------------------------------------
// beta 版 (#843 / ADR-0055 の決定 2・4)
// ---------------------------------------------------------------------------

const betas = (year, month, from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) => `v${year}.${month}.0-beta.${from + i}`);

describe('nextBetaVersion', () => {
  const cases = [
    { today: { year: 2026, month: 11 }, tags: ['v1.4.0'], expected: 'v2027.2.0-beta.1' },
    { today: { year: 2026, month: 12 }, tags: ['v1.4.0', ...betas(2027, 2, 1, 9)], expected: 'v2027.2.0-beta.10' },
    { today: { year: 2027, month: 2 }, tags: ['v1.4.0', ...betas(2027, 2, 1, 40)], expected: 'v2027.2.0-beta.41' },
    { today: { year: 2027, month: 2 }, tags: [...betas(2027, 2, 1, 40), 'v2027.2.0'], expected: 'v2027.8.0-beta.1' },
    { today: { year: 2027, month: 3 }, tags: ['v1.4.0', ...betas(2027, 2, 1, 40)], expected: 'v2027.8.0-beta.1' },
  ];
  for (const { today, tags, expected } of cases) {
    const shown = tags.length > 3 ? `${tags.length} tags` : tags.join(', ');
    it(`picks ${expected} on ${today.year}-${today.month} with ${shown}`, () => {
      assert.equal(nextBetaVersion(today, tags), expected);
    });
  }

  it('compares N as a number, so beta.2 and beta.10 lead to beta.11', () => {
    assert.equal(
      nextBetaVersion({ year: 2026, month: 12 }, ['v2027.2.0-beta.2', 'v2027.2.0-beta.10']),
      'v2027.2.0-beta.11'
    );
  });

  it('does not count beta tags of another cycle', () => {
    assert.equal(
      nextBetaVersion({ year: 2027, month: 3 }, ['v2027.2.0-beta.7', 'v2028.2.0-beta.3', 'v2027.8.0-beta.2x']),
      'v2027.8.0-beta.1'
    );
  });
});

describe('cycleFor', () => {
  const cases = [
    { today: { year: 2027, month: 1 }, tags: [], expected: { year: 2027, month: 2 } },
    { today: { year: 2027, month: 2 }, tags: [], expected: { year: 2027, month: 2 } },
    { today: { year: 2027, month: 3 }, tags: [], expected: { year: 2027, month: 8 } },
    { today: { year: 2027, month: 8 }, tags: [], expected: { year: 2027, month: 8 } },
    { today: { year: 2027, month: 9 }, tags: [], expected: { year: 2028, month: 2 } },
    { today: { year: 2027, month: 12 }, tags: [], expected: { year: 2028, month: 2 } },
    { today: { year: 2027, month: 8 }, tags: ['v2027.8.0'], expected: { year: 2028, month: 2 } },
    { today: { year: 2027, month: 2 }, tags: ['v2027.2.0', 'v2027.8.0'], expected: { year: 2028, month: 2 } },
  ];
  for (const { today, tags, expected } of cases) {
    it(`heads for ${expected.year}.${expected.month} on ${today.year}-${today.month} with [${tags.join(', ')}]`, () => {
      assert.deepEqual(cycleFor(today, tags), expected);
    });
  }
});

describe('jstYearMonth', () => {
  it('reads 20:47 UTC on Feb 28 as March in JST', () => {
    assert.deepEqual(jstYearMonth(new Date('2027-02-28T20:47:00Z')), { year: 2027, month: 3 });
  });

  it('reads 14:59 UTC on Feb 28 as February in JST', () => {
    assert.deepEqual(jstYearMonth(new Date('2027-02-28T14:59:00Z')), { year: 2027, month: 2 });
  });
});

describe('verifiedShasFromRuns', () => {
  it('counts only successful runs, not failed, cancelled or in-progress ones', () => {
    const shas = verifiedShasFromRuns([
      { head_sha: 'ok', conclusion: 'success' },
      { head_sha: 'failed', conclusion: 'failure' },
      { head_sha: 'cancelled', conclusion: 'cancelled' },
      { head_sha: 'running', conclusion: null },
    ]);
    assert.deepEqual([...shas], ['ok']);
  });

  it('throws when the runs are not an array', () => {
    assert.throws(() => verifiedShasFromRuns(undefined), /配列ではない/);
  });
});

describe('pickVerifiedCommit', () => {
  const commits = [
    { sha: 'tip', subject: 'fix: tip' },
    { sha: 'mid', subject: 'docs: mid' },
    { sha: 'old', subject: 'fix: old' },
  ];

  it('skips an unverified tip and picks the newest verified commit behind it', () => {
    assert.equal(pickVerifiedCommit(commits, new Set(['old', 'mid']))?.sha, 'mid');
  });

  it('returns null when no commit is verified', () => {
    assert.equal(pickVerifiedCommit(commits, ['elsewhere']), null);
  });

  it('returns null for no commits', () => {
    assert.equal(pickVerifiedCommit([], ['tip']), null);
  });
});

describe('planBeta', () => {
  const today = { year: 2026, month: 11 };
  const tags = ['v1.4.0'];

  it('skips when the commits are only docs / chore / ci', () => {
    const plan = planBeta({
      today,
      tags,
      commits: [
        { sha: 'c', subject: 'ci: c' },
        { sha: 'b', subject: 'chore: b' },
        { sha: 'a', subject: 'docs: a' },
      ],
      verifiedShas: ['c'],
    });
    assert.equal(plan.release, false);
    assert.match(plan.reason, /fix \/ feat が無い/);
  });

  it('skips when the only fix is newer than the verified commit', () => {
    const plan = planBeta({
      today,
      tags,
      commits: [
        { sha: 'new', subject: 'fix: not deployed yet' },
        { sha: 'verified', subject: 'docs: deployed' },
      ],
      verifiedShas: ['verified'],
    });
    assert.equal(plan.release, false);
    assert.match(plan.reason, /fix \/ feat が無い/);
  });

  it('releases the verified commit when it or an older commit since the tag is a feat', () => {
    const plan = planBeta({
      today,
      tags,
      commits: [
        { sha: 'new', subject: 'docs: newer' },
        { sha: 'verified', subject: 'chore: deployed' },
        { sha: 'old', subject: 'feat(editor): older' },
      ],
      verifiedShas: ['verified', 'old'],
    });
    assert.deepEqual(plan, { release: true, tag: 'v2027.2.0-beta.1', sha: 'verified' });
  });

  it('skips with its own reason when there is no commit since the latest tag', () => {
    const plan = planBeta({ today, tags, commits: [], verifiedShas: ['x'] });
    assert.equal(plan.release, false);
    assert.match(plan.reason, /コミットが無い/);
  });

  it('skips when no commit since the latest tag has a successful Deploy', () => {
    const plan = planBeta({ today, tags, commits: [{ sha: 'a', subject: 'fix: a' }], verifiedShas: [] });
    assert.equal(plan.release, false);
    assert.match(plan.reason, /Deploy が success のものが無い/);
  });
});

describe('release.mjs beta (CLI on a throwaway git repository)', () => {
  let repo;
  let git;
  let commit;
  let fixSha;
  let docsSha;
  let docsOnlySha;
  let runsDir;
  let runsCount = 0;
  /** Deploy の run の一覧を API の応答と同じ形で書き、RELEASE_DEPLOY_RUNS_FILE で渡す (gh を呼ばない)。 */
  const beta = (runs, ...args) => {
    runsCount += 1;
    const file = join(runsDir, `runs-${runsCount}.json`);
    writeFileSync(file, JSON.stringify({ workflow_runs: runs }));
    return spawnSync(process.execPath, [SCRIPT, 'beta', ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, RELEASE_DEPLOY_RUNS_FILE: file, GITHUB_REPOSITORY: '' },
    });
  };

  before(() => {
    runsDir = mkdtempSync(join(tmpdir(), 'release-beta-runs-'));
    ({ repo, git, commit } = throwawayRepo('release-beta-'));
    commit('chore: init', { 'README.md': 'repo\n' });
    git('tag', 'v1.4.0');
    fixSha = commit('fix(editor): a');
    docsSha = commit('docs: b');
    // タグから docs だけが積まれた枝 (fix / feat が無いときの見送り)
    git('checkout', '-q', '-b', 'docs-only', 'v1.4.0');
    docsOnlySha = commit('docs: only docs');
    git('checkout', '-q', 'main');
  });
  after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runsDir, { recursive: true, force: true });
  });

  it('prints tag= and sha= of the newest verified commit and exits 0', () => {
    const result = beta(
      [
        { head_sha: fixSha, conclusion: 'success' },
        { head_sha: docsSha, conclusion: null },
      ],
      '--ref',
      'HEAD',
      '--today',
      '2026-11-20'
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `tag=v2027.2.0-beta.1\nsha=${fixSha}\n`);
  });

  it('exits 3 with a reason on stderr when there is no fix / feat up to the verified commit', () => {
    const result = beta(
      [{ head_sha: docsOnlySha, conclusion: 'success' }],
      '--ref',
      'docs-only',
      '--today',
      '2026-11-20'
    );
    assert.equal(result.status, EXIT_SKIP);
    assert.equal(EXIT_SKIP, 3);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /見送り: .*fix \/ feat が無い/);
  });

  it('exits 3 when no commit since the latest tag has a successful Deploy run', () => {
    const result = beta(
      [
        { head_sha: fixSha, conclusion: 'failure' },
        { head_sha: docsSha, conclusion: 'cancelled' },
      ],
      '--ref',
      'HEAD',
      '--today',
      '2026-11-20'
    );
    assert.equal(result.status, EXIT_SKIP);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Deploy が success のものが無い/);
  });

  it('exits 2 when --today is malformed', () => {
    const result = beta([{ head_sha: fixSha, conclusion: 'success' }], '--ref', 'HEAD', '--today', '2026/11/20');
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /YYYY-MM-DD/);
  });
});

// ---------------------------------------------------------------------------
// ワークフローの条件の固定 (YAML の依存を足さないため、行で job の範囲を切り出して読む)
// ---------------------------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readWorkflow = (name) => readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8');

/** job の直下の `if:` の値。job か `if:` が無ければ throw。 */
function jobIf(workflowText, job) {
  const lines = workflowText.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^ {2}${job}:\\s*$`).test(line));
  if (start < 0) throw new Error(`job ${job} not found`);
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}[\w-]+:\s*$/.test(line)) break;
    const match = /^ {4}if:\s*(.+)$/.exec(line);
    if (match) return match[1];
  }
  throw new Error(`if: not found directly under job ${job}`);
}

describe('deploy.yml keeps beta tags away from production', () => {
  const deploy = readWorkflow('deploy.yml');
  for (const job of ['nightly-gate', 'deploy-production']) {
    it(`runs ${job} only for v* tags without "-"`, () => {
      const condition = jobIf(deploy, job);
      assert.ok(condition.includes("startsWith(github.ref, 'refs/tags/v')"), condition);
      assert.ok(condition.includes("!contains(github.ref_name, '-')"), condition);
    });
  }
});

describe('release.yml creates beta releases as prereleases, one run at a time', () => {
  const release = readWorkflow('release.yml');

  it('passes --prerelease and --latest=false to every gh release create', () => {
    const creates = release
      .split('\n')
      .filter((line) => !line.trim().startsWith('#') && line.includes('gh release create'));
    assert.ok(creates.length > 0, 'no gh release create in release.yml');
    for (const line of creates) {
      assert.ok(line.includes('--prerelease'), line);
      assert.ok(line.includes('--latest=false'), line);
    }
  });

  it('has a top-level concurrency group', () => {
    assert.match(release, /^concurrency:\s*$/m);
  });
});
