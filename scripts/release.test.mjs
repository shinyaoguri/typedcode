/**
 * scripts/release.mjs (changelog.d の断片から Release ノートを組む・断片を検査する。#842 / ADR-0055) の検証。
 * 実行: `node --test scripts/release.test.mjs` (CI は check job が scripts/*.test.mjs を回す)。
 *
 * notes の git の扱い (前回のタグ・追加された断片・断片を足したコミットの除外) は、使い捨ての git
 * リポジトリを組み立てて CLI を実際に打って確かめる。
 */

import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildReleaseNotes, EMPTY_NOTES, isReleaseSubject, lintFragments } from './release.mjs';

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

describe('release.mjs notes (CLI on a throwaway git repository)', () => {
  let repo;
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  const commit = (subject, files = {}) => {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), body);
    }
    git('add', '-A');
    git('commit', '--allow-empty', '-q', '-m', subject);
  };
  const notes = (...args) => spawnSync(process.execPath, [SCRIPT, 'notes', ...args], { cwd: repo, encoding: 'utf8' });

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'release-notes-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Release Test');
    git('config', 'user.email', 'release-test@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'tag.gpgsign', 'false');
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
