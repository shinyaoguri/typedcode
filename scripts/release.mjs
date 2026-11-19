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
 *   node scripts/release.mjs beta [--today YYYY-MM-DD] [--ref <ref>]
 *     次の beta 版 (`vYYYY.M.0-beta.N`) と、それを打つコミットを決める (#843 / ADR-0055 の決定 2・4)。
 *     打つのは `<ref>` (既定 origin/main) の最新のタグより新しいコミットのうち、Deploy (deploy.yml) の
 *     main push の run が success の最新のもの。そこまでに fix / feat が無ければ見送る。
 *     出すときは stdout に `tag=<版>` と `sha=<コミット>` の 2 行で exit 0、見送るときは理由を stderr に出して
 *     exit 3 (EXIT_SKIP)。入力の誤り・git / API の失敗は exit 2。「今日」の既定は JST の日付。
 *     Deploy の run は `gh api` で読む (GITHUB_REPOSITORY が要る)。環境変数 RELEASE_DEPLOY_RUNS_FILE に
 *     API の応答と同じ形の JSON のファイルを渡すと、gh を呼ばずにそれを読む (テストと手元の下見用)
 *
 * 判定 (名前の形・節の振り分け・ノートの組み立て・lint・版とコミットの選択) は純関数。git・GitHub API と
 * ファイルの読み書きは CLI 部分 (main) に閉じる。
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
 * beta 版を出すかの判定 (planBeta) とノートの節の振り分け (commitCategory) が同じ規則を使う。
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
// beta 版 (#843 / ADR-0055 の決定 2・4)
// ---------------------------------------------------------------------------

/** beta を見送るときの終了コード (失敗の 2 と分け、ワークフローが緑で終えられるようにする)。 */
export const EXIT_SKIP = 3;

/** その月以降で最初に来るリリース月 (2 か 8。リリース月は月末まで含む)。 */
function firstCycleFrom({ year, month }) {
  if (month <= 2) return { year, month: 2 };
  if (month <= 8) return { year, month: 8 };
  return { year: year + 1, month: 2 };
}

/** 次のサイクル (2 月 → 同年 8 月、8 月 → 翌年 2 月)。 */
function nextCycle({ year, month }) {
  return month === 2 ? { year, month: 8 } : { year: year + 1, month: 2 };
}

/**
 * beta が向かうサイクル (純関数)。その月以降で最初に来るリリース月で、そのサイクルの正式版
 * `v<year>.<month>.0` が既に `tags` にあれば次のサイクルへ進む。
 *
 * @param {{ year: number, month: number }} today
 * @param {Iterable<string>} tags
 * @returns {{ year: number, month: number }}
 */
export function cycleFor(today, tags) {
  const released = new Set(tags);
  let cycle = firstCycleFrom(today);
  while (released.has(`v${cycle.year}.${cycle.month}.0`)) cycle = nextCycle(cycle);
  return cycle;
}

/**
 * 次の beta 版のタグ名 (純関数)。`N` は同じサイクルの beta タグの最大 + 1 (数として比べる)。無ければ 1。
 *
 * @param {{ year: number, month: number }} today
 * @param {Iterable<string>} tags
 * @returns {string} `v<year>.<month>.0-beta.<N>`
 */
export function nextBetaVersion(today, tags) {
  const list = [...tags];
  const { year, month } = cycleFor(today, list);
  const pattern = new RegExp(`^v${year}\\.${month}\\.0-beta\\.(\\d+)$`);
  let max = 0;
  for (const tag of list) {
    const match = pattern.exec(tag);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `v${year}.${month}.0-beta.${max + 1}`;
}

/**
 * Deploy の run の一覧 (API の `workflow_runs`) から、success で終わった run の head_sha の集合を作る (純関数)。
 * 失敗・キャンセル・進行中 (`conclusion: null`) は数えない。
 *
 * @param {{ head_sha: string, conclusion: string | null }[]} runs
 * @returns {Set<string>}
 */
export function verifiedShasFromRuns(runs) {
  if (!Array.isArray(runs)) throw new Error('workflow_runs が配列ではない (API の応答の形が違う)');
  return new Set(runs.filter((run) => run.conclusion === 'success').map((run) => run.head_sha));
}

/**
 * 検査済み (Deploy が success) のコミットのうち最新のもの (純関数)。
 *
 * @param {{ sha: string, subject: string }[]} commits 最新のタグより新しい main のコミット (新しい順)
 * @param {Set<string> | string[]} verifiedShas
 * @returns {{ sha: string, subject: string } | null}
 */
export function pickVerifiedCommit(commits, verifiedShas) {
  const verified = verifiedShas instanceof Set ? verifiedShas : new Set(verifiedShas);
  return commits.find((commit) => verified.has(commit.sha)) ?? null;
}

/**
 * beta 版を出すかと、出すならその版とコミットを決める (純関数)。
 * fix / feat は、最新のタグから選んだコミットまでで数える (main の先端までではない)。
 *
 * @param {{
 *   today: { year: number, month: number },
 *   tags: Iterable<string>,
 *   commits: { sha: string, subject: string }[],
 *   verifiedShas: Set<string> | string[],
 * }} input commits は最新のタグより新しい main のコミット (新しい順)
 * @returns {{ release: true, tag: string, sha: string } | { release: false, reason: string }}
 */
export function planBeta({ today, tags, commits, verifiedShas }) {
  if (commits.length === 0) return { release: false, reason: '最新のタグ以降にコミットが無い' };
  const picked = pickVerifiedCommit(commits, verifiedShas);
  if (!picked) {
    return { release: false, reason: '最新のタグより新しいコミットに、Deploy が success のものが無い' };
  }
  const included = commits.slice(commits.indexOf(picked));
  if (!included.some((commit) => isReleaseSubject(commit.subject))) {
    return {
      release: false,
      reason: `最新のタグから Deploy が success のコミット (${picked.sha.slice(0, 12)}) までに fix / feat が無い`,
    };
  }
  return { release: true, tag: nextBetaVersion(today, tags), sha: picked.sha };
}

/** JST (Asia/Tokyo) での年と月 (純関数)。 */
export function jstYearMonth(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(date);
  const value = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value('year'), month: value('month') };
}

/** `--today YYYY-MM-DD` を年と月にする。形に合わなければ throw。 */
export function parseToday(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const month = match ? Number(match[2]) : 0;
  const day = match ? Number(match[3]) : 0;
  if (!match || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`--today は YYYY-MM-DD の形で渡す (受け取った値: ${text})`);
  }
  return { year: Number(match[1]), month };
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

/**
 * Deploy (deploy.yml) の main push の完了 run の一覧。RELEASE_DEPLOY_RUNS_FILE があれば gh を呼ばずにそれを読む
 * (テストと手元の下見用の差し替え口)。
 */
function deployRuns() {
  const file = process.env.RELEASE_DEPLOY_RUNS_FILE;
  if (file) return JSON.parse(readFileSync(file, 'utf8')).workflow_runs;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) {
    throw new Error('GITHUB_REPOSITORY (owner/name) が要る');
  }
  const output = execFileSync(
    'gh',
    [
      'api',
      `repos/${repository}/actions/workflows/deploy.yml/runs?branch=main&event=push&status=completed&per_page=100`,
    ],
    // 100 件の run の応答は数 MB になり、execFileSync の既定の maxBuffer (1 MiB) を超える (ENOBUFS)
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return JSON.parse(output).workflow_runs;
}

function beta(values) {
  const ref = values.ref ?? 'origin/main';
  const today = values.today === undefined ? jstYearMonth(new Date()) : parseToday(values.today);
  const latest = nearestTag(ref);
  if (!latest) {
    console.error(
      `release beta: ${ref} から辿れる v* タグが無い。全履歴とタグを取ってから打つ (git fetch --tags origin。CI なら fetch-depth: 0)`
    );
    return 2;
  }
  const commits = lines(git(['log', '--first-parent', '--format=%H%x00%s', `${latest}..${ref}`])).map((line) => {
    const [sha, subject] = line.split('\0');
    return { sha, subject };
  });
  const tags = lines(git(['tag', '--list', 'v*']));
  const plan = planBeta({ today, tags, commits, verifiedShas: verifiedShasFromRuns(deployRuns()) });
  if (!plan.release) {
    console.error(`release beta: 見送り: ${plan.reason} (最新のタグ: ${latest})`);
    return EXIT_SKIP;
  }
  process.stdout.write(`tag=${plan.tag}\nsha=${plan.sha}\n`);
  return 0;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === 'beta') {
      const { values } = parseArgs({
        args: rest,
        options: { today: { type: 'string' }, ref: { type: 'string' } },
      });
      process.exitCode = beta(values);
    } else if (command === 'notes') {
      const { values } = parseArgs({
        args: rest,
        options: { since: { type: 'string' }, to: { type: 'string' } },
      });
      process.exitCode = notes(values);
    } else if (command === 'lint') {
      parseArgs({ args: rest, options: {} });
      process.exitCode = lint();
    } else {
      console.error(
        '使い方: node scripts/release.mjs notes [--since <tag>] [--to <ref>] | lint | beta [--today YYYY-MM-DD] [--ref <ref>]\n' +
          '  beta: 環境変数 RELEASE_DEPLOY_RUNS_FILE に Deploy の run の一覧 (API の応答と同じ形の JSON) を渡すと gh を呼ばずにそれを読む'
      );
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(`release ${command}: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
