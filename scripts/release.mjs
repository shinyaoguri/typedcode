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
 *   node scripts/release.mjs promote --beta <beta タグ> [--today YYYY-MM-DD]
 *     beta タグを正式版へ昇格するときの版を決める (#844 / ADR-0055 の決定 5)。正式版は beta タグから `-beta.N` を
 *     除いた名前で、beta と同じコミットに打つ。通れば stdout に `tag=<正式版>`・`sha=<beta のコミット>`・
 *     `since=<前回の正式版>` の 3 行で exit 0。拒否 (beta 形でない・タグが無い・そのサイクルの正式版が既にある・
 *     サイクルの月がまだ来ていない・前回の正式版が辿れない) は理由を stderr に出して exit 2。
 *     前回の正式版は、そのコミットから辿れる最も近い `-` を含まない `v*` タグ (正式版のノートは途中の beta をまたぐ)
 *   node scripts/release.mjs patch --branch release/A.B [--ref <ref>]
 *     `release/A.B` の先端 (`<ref>`。既定 origin/release/A.B) に打つ patch の版を決める (#844 / ADR-0055 の決定 6)。
 *     通れば stdout に `tag=vA.B.P` と `sha=<先端>` の 2 行で exit 0。拒否 (ブランチの形・`vA.B.0` が無い・先端が
 *     `vA.B.0` の子孫でない・先端に既に `vA.B.*` のタグがある = 新しいコミットが無い) は exit 2
 *   node scripts/release.mjs verify-tag <tag>
 *     production へ出すタグの位置を検証する (deploy.yml の deploy-production が呼ぶ)。`.0` は origin/main の祖先、
 *     patch は origin/release/A.B の祖先で `vA.B.0` の子孫であること。beta 形は対象外。通れば exit 0、
 *     拒否と参照の解決の失敗 (fetch されていない) は理由を stderr に出して exit 1
 *
 * 判定 (名前の形・節の振り分け・ノートの組み立て・lint・版とコミットの選択・昇格と patch の版・タグの位置) は純関数。git・GitHub API と
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

// ---------------------------------------------------------------------------
// 正式版の昇格と patch (#844 / ADR-0055 の決定 5・6)
// ---------------------------------------------------------------------------

/** 版のタグの形: `vA.B.P` か `vA.B.P-beta.N`。 */
const VERSION_TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/;

/**
 * 版のタグを読む (純関数)。形に合わなければ null。
 *
 * @param {string} tag
 * @returns {{ a: number, b: number, patch: number, beta: number | null } | null}
 */
export function parseVersionTag(tag) {
  const match = VERSION_TAG.exec(tag);
  if (!match) return null;
  return {
    a: Number(match[1]),
    b: Number(match[2]),
    patch: Number(match[3]),
    beta: match[4] === undefined ? null : Number(match[4]),
  };
}

/**
 * beta タグを正式版へ昇格するときの版を決める (純関数)。正式版の名前は beta タグから `-beta.N` を除いたもの。
 * サイクルの月がまだ来ていない beta は拒否する (3 月に `v2027.8.0-beta.N` を昇格すると、8 月の正式版が
 * `v2028.2.0` を名乗ることになるため。#844)。
 *
 * @param {{ betaTag: string, tags: Iterable<string>, today: { year: number, month: number } }} input
 * @returns {{ ok: true, tag: string } | { ok: false, reason: string }}
 */
export function planPromotion({ betaTag, tags, today }) {
  const version = parseVersionTag(betaTag);
  if (!version || version.beta === null || version.patch !== 0) {
    return { ok: false, reason: `${betaTag} は beta 形 (vYYYY.M.0-beta.N) のタグではない` };
  }
  const existing = new Set(tags);
  if (!existing.has(betaTag)) return { ok: false, reason: `${betaTag} というタグが無い` };
  const tag = `v${version.a}.${version.b}.0`;
  if (existing.has(tag)) return { ok: false, reason: `このサイクルの正式版 ${tag} は既に出ている` };
  if (today.year < version.a || (today.year === version.a && today.month < version.b)) {
    return {
      ok: false,
      reason: `サイクル ${version.a}.${version.b} の月がまだ来ていない (今日は ${today.year}-${today.month})。遅れた正式版は、その前のサイクルの最後の beta を昇格する`,
    };
  }
  return { ok: true, tag };
}

/**
 * `release/A.B` から出す patch の版を決める (純関数)。P は `vA.B.<数>` (beta 形を除く) の最大 + 1 (数として比べる)。
 *
 * @param {{ branch: string, tags: Iterable<string> }} input
 * @returns {{ ok: true, tag: string, base: string } | { ok: false, reason: string }}
 */
export function planPatch({ branch, tags }) {
  const match = /^release\/(\d+)\.(\d+)$/.exec(branch);
  if (!match) return { ok: false, reason: `${branch} は release/A.B の形のブランチではない` };
  const series = `${match[1]}.${match[2]}`;
  const base = `v${series}.0`;
  const list = [...tags];
  if (!list.includes(base)) {
    return { ok: false, reason: `${branch} の元になる正式版 ${base} が無い` };
  }
  let max = 0;
  for (const tag of list) {
    const version = parseVersionTag(tag);
    if (version && version.beta === null && `${version.a}.${version.b}` === series) {
      max = Math.max(max, version.patch);
    }
  }
  return { ok: true, tag: `v${series}.${max + 1}`, base };
}

/**
 * production へ出すタグの位置を検証する (純関数。git への問い合わせは注入する)。
 * `.0` は `origin/main` の祖先、patch は `origin/release/A.B` の祖先で、かつ `vA.B.0` の子孫であること。
 * beta 形・形に合わないタグは production の対象外。
 *
 * @param {{ tag: string, isAncestorOf: (ancestorRef: string, descendantRef: string) => boolean }} input
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkTagPlacement({ tag, isAncestorOf }) {
  const version = parseVersionTag(tag);
  if (!version) return { ok: false, reason: `${tag} は版のタグ (vA.B.P) の形ではない (production の対象外)` };
  if (version.beta !== null) return { ok: false, reason: `${tag} は beta 形のタグ (production の対象外)` };
  if (version.patch === 0) {
    return isAncestorOf(tag, 'origin/main')
      ? { ok: true }
      : { ok: false, reason: `正式版 ${tag} のコミットが origin/main の祖先ではない` };
  }
  const branch = `origin/release/${version.a}.${version.b}`;
  const base = `v${version.a}.${version.b}.0`;
  const missing = [];
  if (!isAncestorOf(tag, branch)) missing.push(`${branch} の祖先ではない`);
  if (!isAncestorOf(base, tag)) missing.push(`${base} の子孫ではない`);
  return missing.length === 0 ? { ok: true } : { ok: false, reason: `patch ${tag} のコミットが ${missing.join('、')}` };
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

/** `<ref>` が指すコミット。解決できなければ null。 */
function resolveCommit(ref) {
  try {
    return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim() || null;
  } catch {
    return null;
  }
}

/** 参照が解決できないこと (fetch されていない・無い) を表すエラー。 */
class UnresolvedRefError extends Error {}

/** `git merge-base --is-ancestor`。参照が解決できなければ UnresolvedRefError を throw。 */
function gitIsAncestor(ancestorRef, descendantRef) {
  for (const ref of [ancestorRef, descendantRef]) {
    if (!resolveCommit(ref)) throw new UnresolvedRefError(`参照 ${ref} が解決できない (fetch されていないか、無い)`);
  }
  try {
    git(['merge-base', '--is-ancestor', ancestorRef, descendantRef]);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 1) return false;
    throw error;
  }
}

function promote(values) {
  if (!values.beta) throw new Error('--beta <beta タグ> が要る');
  const today = values.today === undefined ? jstYearMonth(new Date()) : parseToday(values.today);
  const tags = lines(git(['tag', '--list', 'v*']));
  const plan = planPromotion({ betaTag: values.beta, tags, today });
  if (!plan.ok) {
    console.error(`release promote: 拒否: ${plan.reason}`);
    return 2;
  }
  const sha = git(['rev-list', '-n', '1', values.beta]).trim();
  // 前回の正式版 = このコミットから辿れる最も近い、`-` を含まない v* タグ (途中の beta は飛ばす)
  let since;
  try {
    since = git(['describe', '--tags', '--abbrev=0', '--match', 'v*', '--exclude', '*-*', sha]).trim();
  } catch {
    console.error(
      `release promote: 拒否: ${values.beta} から辿れる前回の正式版 (- を含まない v* タグ) が無い。全履歴とタグを取ってから打つ (git fetch --tags origin)`
    );
    return 2;
  }
  process.stdout.write(`tag=${plan.tag}\nsha=${sha}\nsince=${since}\n`);
  return 0;
}

function patch(values) {
  if (!values.branch) throw new Error('--branch release/A.B が要る');
  const tags = lines(git(['tag', '--list', 'v*']));
  const plan = planPatch({ branch: values.branch, tags });
  if (!plan.ok) {
    console.error(`release patch: 拒否: ${plan.reason}`);
    return 2;
  }
  const ref = values.ref ?? `origin/${values.branch}`;
  const sha = resolveCommit(ref);
  if (!sha) {
    console.error(`release patch: 拒否: ${ref} が解決できない (fetch されていないか、ブランチが無い)`);
    return 2;
  }
  if (!gitIsAncestor(plan.base, sha)) {
    console.error(`release patch: 拒否: ${ref} の先端 (${sha.slice(0, 12)}) が ${plan.base} の子孫ではない`);
    return 2;
  }
  const series = plan.base.slice(0, -'.0'.length);
  const already = lines(git(['tag', '--points-at', sha, '--list', 'v*'])).filter((tag) => {
    const version = parseVersionTag(tag);
    return version !== null && version.beta === null && tag.startsWith(`${series}.`);
  });
  if (already.length > 0) {
    console.error(
      `release patch: 拒否: ${ref} の先端 (${sha.slice(0, 12)}) には既に ${already.join(', ')} が付いている (新しいコミットが無い)`
    );
    return 2;
  }
  process.stdout.write(`tag=${plan.tag}\nsha=${sha}\n`);
  return 0;
}

function verifyTag(tag) {
  let result;
  try {
    result = checkTagPlacement({ tag, isAncestorOf: gitIsAncestor });
  } catch (error) {
    if (!(error instanceof UnresolvedRefError)) throw error;
    result = { ok: false, reason: error.message };
  }
  if (!result.ok) {
    console.error(`release verify-tag: 拒否: ${result.reason}`);
    return 1;
  }
  process.stdout.write(`release verify-tag: ${tag} は production へ出してよい位置にある\n`);
  return 0;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === 'promote') {
      const { values } = parseArgs({
        args: rest,
        options: { beta: { type: 'string' }, today: { type: 'string' } },
      });
      process.exitCode = promote(values);
    } else if (command === 'patch') {
      const { values } = parseArgs({
        args: rest,
        options: { branch: { type: 'string' }, ref: { type: 'string' } },
      });
      process.exitCode = patch(values);
    } else if (command === 'verify-tag') {
      const { positionals } = parseArgs({ args: rest, options: {}, allowPositionals: true });
      if (positionals.length !== 1) throw new Error('タグを 1 つ渡す (verify-tag <tag>)');
      process.exitCode = verifyTag(positionals[0]);
    } else if (command === 'beta') {
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
          '  | promote --beta <beta タグ> [--today YYYY-MM-DD] | patch --branch release/A.B [--ref <ref>] | verify-tag <tag>\n' +
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
