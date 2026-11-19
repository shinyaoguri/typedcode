#!/usr/bin/env node
/**
 * 変更履歴の断片 (`changelog.d/`) から GitHub Release のノートを組み、断片の形を検査する
 * (#842 / ADR-0055 の決定 3)。書き方は changelog.d/README.md。
 *
 * サブコマンド:
 *   node scripts/release.mjs notes [--since <tag>] [--to <ref>]
 *     前回のタグ (既定: `<to>` から辿れる最も近い `v*` タグ。版の大小では決めない) から `<to>` (既定 HEAD)
 *     までに**追加された**断片と、断片の無い fix / feat のコミット件名から、ノートの Markdown を stdout に出す。
 *     タグが辿れず `--since` も無ければ exit 1 (全履歴とタグが要る。CI では fetch-depth: 0 と git fetch --tags)
 *   node scripts/release.mjs lint
 *     `changelog.d/` 直下のファイルの名前と本文を検査する。問題があれば stderr に出して exit 1
 *
 * 判定 (名前の形・節の振り分け・ノートの組み立て・lint) は純関数。git とファイルの読み書きは CLI 部分 (main) に閉じる。
 * 断片は消さない (どれが今回の分かは git の履歴が知っている)。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** 断片を置くディレクトリ (リポジトリのルートからの相対)。 */
export const FRAGMENT_DIR = 'changelog.d';

/** 断片の名前: `<slug>.<category>.md`。slug は kebab-case。 */
export const FRAGMENT_NAME = /^[a-z0-9]+(-[a-z0-9]+)*\.(breaking|feature|fix|perf|docs)\.md$/;

/**
 * 利用者に届く変更 (fix / feat。scope と破壊的変更の `!` を含む) のコミット件名。
 * scripts/release-stall.mjs の RELEASE_SUBJECT と同じ規則 (あちらは次の段階で消えるので import しない)。
 */
export const RELEASE_SUBJECT = /^(fix|feat)(\(.+\))?!?:/;

/** ノートの節。この順で出す。 */
export const SECTIONS = [
  { category: 'breaking', title: '破壊的変更' },
  { category: 'feature', title: '新機能' },
  { category: 'fix', title: '修正' },
  { category: 'perf', title: '性能' },
  { category: 'docs', title: 'ドキュメント' },
];

/** 節が 1 つも無いときのノート。 */
export const EMPTY_NOTES = '利用者に見える変更はありません。';

/** 断片のファイル名から category を返す。形に合わなければ null。 */
export function fragmentCategory(name) {
  const match = FRAGMENT_NAME.exec(name);
  return match ? match[2] : null;
}

/** `changelog.d/<名前>` のうち、直下にあって名前が形に合うものか。README.md と下位ディレクトリは数えない。 */
export function isFragmentPath(path) {
  const prefix = `${FRAGMENT_DIR}/`;
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  return !rest.includes('/') && fragmentCategory(rest) !== null;
}

/** HTML コメントを落とし、前後の空白を除いた本文。 */
export function fragmentText(body) {
  return body.replace(/<!--[\s\S]*?-->/g, '').trim();
}

/** fix / feat のコミット件名か。 */
export function isReleaseSubject(subject) {
  return RELEASE_SUBJECT.test(subject);
}

/** 断片の無いコミットの件名が入る節。fix / feat でなければ null。 */
export function commitCategory(subject) {
  const match = /^(fix|feat)(\(.+\))?(!?):/.exec(subject);
  if (!match) return null;
  if (match[3] === '!') return 'breaking';
  return match[1] === 'feat' ? 'feature' : 'fix';
}

/** 本文を 1 つの箇条書きの項目にする (2 行目以降をインデントする。空行はそのまま)。 */
function bulletItem(text) {
  const [first, ...rest] = text.split('\n');
  return [`- ${first}`, ...rest.map((line) => (line.trim() === '' ? '' : `  ${line}`))].join('\n');
}

/**
 * ノートの Markdown を組む (純関数)。
 *
 * @param {{
 *   fragments: { name: string, body: string }[],
 *   commits: { subject: string, addedFragments: string[] }[],
 * }} input fragments = 範囲内に追加された断片 (ファイル名と本文)。commits = 範囲内のコミット (古い順) と、
 *   そのコミットが追加した断片のパス
 * @returns {string} 末尾に改行を 1 つ持つ Markdown
 */
export function buildReleaseNotes({ fragments, commits }) {
  const items = new Map(SECTIONS.map(({ category }) => [category, []]));

  for (const fragment of [...fragments].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const category = fragmentCategory(fragment.name);
    const text = fragmentText(fragment.body);
    if (category === null || text === '') continue;
    items.get(category).push(bulletItem(text));
  }
  for (const commit of commits) {
    if (commit.addedFragments.length > 0) continue;
    const category = commitCategory(commit.subject);
    if (category === null) continue;
    items.get(category).push(bulletItem(commit.subject));
  }

  const blocks = SECTIONS.filter(({ category }) => items.get(category).length > 0).map(
    ({ category, title }) => `## ${title}\n\n${items.get(category).join('\n')}`
  );
  return `${blocks.length === 0 ? EMPTY_NOTES : blocks.join('\n\n')}\n`;
}

/**
 * `changelog.d/` 直下の項目を検査する (純関数)。README.md は通し、ディレクトリは見ない。
 *
 * @param {{ name: string, isDirectory: boolean, body?: string }[]} entries
 * @returns {{ name: string, reason: string }[]}
 */
export function lintFragments(entries) {
  const problems = [];
  for (const entry of entries) {
    if (entry.isDirectory || entry.name === 'README.md') continue;
    if (!FRAGMENT_NAME.test(entry.name)) {
      problems.push({
        name: entry.name,
        reason:
          '名前が <slug>.<category>.md の形に合わない (slug は英小文字・数字・ハイフン、category は breaking / feature / fix / perf / docs)',
      });
      continue;
    }
    if (fragmentText(entry.body ?? '') === '') {
      problems.push({ name: entry.name, reason: '本文が空 (HTML コメントと空白を除くと何も残らない)' });
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// CLI (git とファイルの読み書きはここだけ)
// ---------------------------------------------------------------------------

/** git を実行して stdout を返す。 */
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function lines(text) {
  return text.split('\n').filter(Boolean);
}

/** `to` から辿れる最も近い `v*` タグ。無ければ null。 */
function nearestTag(to) {
  try {
    return git(['describe', '--tags', '--abbrev=0', '--match', 'v*', to]).trim();
  } catch {
    return null;
  }
}

function notes(values) {
  const to = values.to ?? 'HEAD';
  const since = values.since ?? nearestTag(to);
  if (!since) {
    console.error(
      `release notes: ${to} から辿れる v* タグが無い。前回のタグを --since で渡すか、全履歴とタグを取ってから打つ (git fetch --tags origin。CI なら fetch-depth: 0)`
    );
    return 1;
  }
  const range = `${since}..${to}`;

  const added = lines(git(['diff', '--name-only', '--diff-filter=A', range, '--', FRAGMENT_DIR])).filter(
    isFragmentPath
  );
  const fragments = added.map((path) => ({
    name: path.slice(FRAGMENT_DIR.length + 1),
    body: git(['show', `${to}:${path}`]),
  }));

  // コミットごとに追加した断片 (main は squash merge なので 1 PR = 1 コミット。--first-parent で辿る)
  const addedBy = new Map();
  let current = null;
  for (const line of lines(
    git([
      'log',
      '--first-parent',
      '--diff-merges=first-parent',
      '--diff-filter=A',
      '--name-only',
      '--format=%x1e%H',
      range,
      '--',
      FRAGMENT_DIR,
    ])
  )) {
    if (line.startsWith('\x1e')) {
      current = line.slice(1);
      addedBy.set(current, []);
    } else if (current && isFragmentPath(line)) {
      addedBy.get(current).push(line);
    }
  }
  const commits = lines(git(['log', '--first-parent', '--reverse', '--format=%H%x00%s', range])).map((line) => {
    const [sha, subject] = line.split('\0');
    return { subject, addedFragments: addedBy.get(sha) ?? [] };
  });

  process.stdout.write(buildReleaseNotes({ fragments, commits }));
  return 0;
}

function lint() {
  if (!existsSync(FRAGMENT_DIR)) return 0;
  const entries = readdirSync(FRAGMENT_DIR, { withFileTypes: true }).map((dirent) => ({
    name: dirent.name,
    isDirectory: dirent.isDirectory(),
    body: dirent.isFile() ? readFileSync(join(FRAGMENT_DIR, dirent.name), 'utf8') : undefined,
  }));
  const problems = lintFragments(entries);
  for (const { name, reason } of problems) console.error(`${FRAGMENT_DIR}/${name}: ${reason}`);
  if (problems.length > 0) {
    console.error(`release lint: ${problems.length} 件の問題 (書き方は ${FRAGMENT_DIR}/README.md)`);
    return 1;
  }
  return 0;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === 'notes') {
      const { values } = parseArgs({
        args: rest,
        options: { since: { type: 'string' }, to: { type: 'string' } },
      });
      process.exitCode = notes(values);
    } else if (command === 'lint') {
      parseArgs({ args: rest, options: {} });
      process.exitCode = lint();
    } else {
      console.error('使い方: node scripts/release.mjs notes [--since <tag>] [--to <ref>] | lint');
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(`release ${command}: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
