#!/usr/bin/env node
/**
 * E2E の flaky の収集 (#583) — CI の E2E は `retries: 1` なので、1 回目に落ちて retry で通ったテストは
 * run が緑になり、Playwright の notice しか残らない。Playwright の JSON レポート (CI のときだけ
 * `packages/e2e/reports/*.json` に出す) から flaky を拾い、見える場所に出す。
 *
 *   - `summary`: deploy.yml の e2e-shard が shard ごとに呼ぶ。flaky の一覧を job summary に出す
 *     (PR の run でも main の run でも。PR の run はこれだけで、Issue には書かない)
 *   - `issue`: deploy.yml の e2e-flaky-report が main への push の run でだけ、全 shard のレポートを集めて
 *     1 回呼ぶ。`test: E2E の flaky (自動)` の open Issue をタイトル一致で探し (無ければ作る)、run の URL・
 *     テスト名・1 回目のエラーの先頭を追記する (e2e-nightly.yml が #455 に失敗を集めるのと同じ形)
 *
 * **観測であって検査ではない**: レポートが無い・壊れているときもその旨を summary に出して exit 0 にする
 * (収集の失敗で e2e の job を赤くしない)。`issue` で gh が失敗したときだけ exit 1 (書けなかったことを見せる。
 * e2e-flaky-report はどの job の needs にも入っていないので、deploy は止まらない)。
 *
 * flaky の定義: Playwright の `status: "flaky"` (期待どおりでない結果のあと、retry で期待どおりになった)。
 * status が無いレポートでは results の並び (最後が期待どおりで、その前に期待どおりでない結果がある) で見る。
 * 最終的に落ちたテスト (`unexpected`) は対象外 (run が赤くなるので、それで見える)。
 *
 * 再実行 (同じ run の re-run) で同じテストを二重に追記しないよう、追記する本文にはテストごとに
 * `<!-- e2e-flaky run=<run id> key=<テストの識別子のハッシュ> -->` を埋め、既存の本文・コメントにある印と照合する。
 * 別の run で同じテストが flaky になったときは追記する (頻度が分かるように)。
 *
 * 判定と本文の組み立ては純関数。ファイルの読み込みと `gh` の呼び出しは CLI 部分 (main) に閉じる。
 *
 * 使い方:
 *   node scripts/e2e-flaky.mjs summary --dir packages/e2e/reports   # job summary へ (GITHUB_STEP_SUMMARY が無ければ stdout)
 *   node scripts/e2e-flaky.mjs issue --dir flaky-reports            # main の run で Issue に追記する
 *
 * `--dir` の下の *.json を再帰で読む。ファイル名 (拡張子なし) を config の名前にする
 * (`e2e` = dev サーバ向け、`e2e-build` = 本番ビルド向け)。run の URL は GITHUB_SERVER_URL /
 * GITHUB_REPOSITORY / GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT から組み立てる。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 集約 Issue のタイトル。タイトル一致で探す (e2e-nightly.yml の #455 と同じ探し方)。 */
export const ISSUE_TITLE = 'test: E2E の flaky (自動)';
/** 1 回目のエラーの先頭として残す行数と文字数。 */
export const ERROR_MAX_LINES = 12;
export const ERROR_MAX_CHARS = 800;

/** ANSI のエスケープ列 (CSI と OSC)。Playwright のエラー文言は色付きで来る。 */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(`${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|[@-Z\\\\-_])`, 'g');

/**
 * @typedef {{
 *   key: string,
 *   config: string,
 *   project: string,
 *   file: string,
 *   line: number,
 *   title: string,
 *   attempts: number,
 *   firstError: string,
 * }} Flaky
 *   key = config・project・場所・タイトルから作る識別子 (shard や retry によらず同じテストなら同じ)
 * @typedef {{ source: string, reason: string }} ReportProblem
 */

/** ANSI のエスケープ列を除く。 */
export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI, '');
}

/** エラー文言の先頭を、ANSI を除いて行数と文字数で切り詰める。切ったら末尾に `…` を付ける。 */
export function errorHead(message) {
  const lines = stripAnsi(message).replace(/\r\n?/g, '\n').trim().split('\n');
  let head = lines.slice(0, ERROR_MAX_LINES).join('\n');
  let cut = lines.length > ERROR_MAX_LINES;
  if (head.length > ERROR_MAX_CHARS) {
    head = head.slice(0, ERROR_MAX_CHARS);
    cut = true;
  }
  return cut ? `${head.trimEnd()}\n…` : head;
}

/** 結果のエラー文言 (error.message、無ければ errors[0].message)。 */
function messageOf(result) {
  return result?.error?.message ?? result?.errors?.[0]?.message ?? '';
}

/**
 * 1 本のテスト (JSONReportTest) が flaky か。`status` があればそれに従い、無ければ results の並びで見る。
 */
export function isFlaky(test) {
  if (test?.status) return test.status === 'flaky';
  const results = test?.results ?? [];
  const expected = test?.expectedStatus ?? 'passed';
  if (results.length < 2) return false;
  const last = results[results.length - 1];
  return last.status === expected && results.slice(0, -1).some((r) => r.status !== expected && r.status !== 'skipped');
}

/** テストの識別子 (印に埋める短いハッシュ)。 */
function keyOf({ config, project, file, line, title }) {
  return createHash('sha256')
    .update(JSON.stringify([config, project, file, line, title]))
    .digest('hex')
    .slice(0, 16);
}

/**
 * 1 つの JSON レポートから flaky を拾う (純関数)。
 *
 * @param {unknown} report Playwright の JSON レポート (JSONReport)
 * @param {string} config レポートの出どころの名前 (`e2e` / `e2e-build`)
 * @returns {Flaky[]}
 */
export function collectFlaky(report, config) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.suites)) {
    throw new Error('Playwright の JSON レポートの形でない (suites が無い)');
  }
  /** @type {Flaky[]} */
  const found = [];
  const walk = (suite, titles) => {
    // 最上位の suite はファイル (title がファイル名) なので、タイトルの並びには入れない
    const path = suite.title && suite.title !== suite.file ? [...titles, suite.title] : titles;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (!isFlaky(test)) continue;
        const results = test.results ?? [];
        const expected = test.expectedStatus ?? 'passed';
        const first = results.find((r) => r.status !== expected && r.status !== 'skipped');
        const entry = {
          config,
          project: test.projectName ?? '',
          file: spec.file ?? suite.file ?? '',
          line: spec.line ?? 0,
          title: [...path, spec.title].join(' › '),
          attempts: results.length,
          firstError: errorHead(messageOf(first)) || '(エラーの文言が無い)',
        };
        found.push({ key: keyOf(entry), ...entry });
      }
    }
    for (const child of suite.suites ?? []) walk(child, path);
  };
  for (const suite of report.suites) walk(suite, []);
  return found;
}

/**
 * 複数のレポート (shard ごと・config ごと) の flaky を 1 つにする (純関数)。同じテストは 1 件にまとめる。
 *
 * @param {{ config: string, report: unknown, source?: string }[]} reports
 * @returns {{ flaky: Flaky[], problems: ReportProblem[] }}
 */
export function mergeReports(reports) {
  /** @type {Map<string, Flaky>} */
  const byKey = new Map();
  /** @type {ReportProblem[]} */
  const problems = [];
  for (const { config, report, source = config } of reports) {
    let found;
    try {
      found = collectFlaky(report, config);
    } catch (error) {
      problems.push({ source, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    for (const flaky of found) if (!byKey.has(flaky.key)) byKey.set(flaky.key, flaky);
  }
  const flaky = [...byKey.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.title.localeCompare(b.title)
  );
  return { flaky, problems };
}

/** 中身に含まれるバッククォートの連続より長いフェンス (中身で閉じられないように)。 */
function fenceFor(text, min) {
  const longest = Math.max(0, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(Math.max(min, longest + 1));
}

/** インラインのコード (`@` や `#123` を自動リンクにしない)。 */
export function codeSpan(text) {
  const value = String(text).replace(/\s+/g, ' ');
  const fence = fenceFor(value, 1);
  const pad = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${value}${pad}${fence}`;
}

/** コードブロック (同上)。 */
export function codeBlock(text) {
  const fence = fenceFor(text, 3);
  return `${fence}\n${text}\n${fence}`;
}

/** 印 (同じ run の再実行で同じテストを二重に追記しないため)。 */
export function markerOf(runId, key) {
  return `<!-- e2e-flaky run=${runId} key=${key} -->`;
}

/**
 * 既に追記済み (同じ run の印がある) のテストを除く (純関数)。
 *
 * @param {Flaky[]} flaky
 * @param {string} runId
 * @param {string[]} existingBodies 集約 Issue の本文と全コメントの本文
 */
export function unreported(flaky, runId, existingBodies) {
  const text = existingBodies.join('\n');
  return flaky.filter((f) => !text.includes(markerOf(runId, f.key)));
}

/** レポートの問題 (無い・壊れている) の行。 */
function problemLines(problems) {
  if (problems.length === 0) return [];
  return [
    '',
    'flaky を集められなかったレポート (収集は観測なので、これで job は落とさない):',
    '',
    ...problems.map((p) => `- ${codeSpan(p.source)}: ${p.reason}`),
  ];
}

/** 1 件の flaky の Markdown。 */
function flakyLines(f) {
  return [
    `### ${codeSpan(f.title)}`,
    '',
    `- 場所: ${codeSpan(`${f.file}:${f.line}`)} (config: ${codeSpan(f.config)}${f.project ? `, project: ${codeSpan(f.project)}` : ''}、試行 ${f.attempts} 回)`,
    '- 1 回目のエラーの先頭:',
    '',
    codeBlock(f.firstError),
  ];
}

/**
 * job summary の Markdown (純関数)。flaky もレポートの問題も無ければ短い 1 行だけにする。
 *
 * @param {{ flaky: Flaky[], problems: ReportProblem[] }} merged
 * @param {{ label?: string }} [context] 見出しに添える名前 (shard など)
 */
export function formatSummary({ flaky, problems }, { label } = {}) {
  const heading = `## E2E の flaky${label ? ` (${label})` : ''}`;
  const lines = [heading, ''];
  if (flaky.length === 0) {
    lines.push(
      problems.length === 0 ? 'retry で通ったテストは無い。' : '読めたレポートには、retry で通ったテストは無い。'
    );
  } else {
    lines.push(
      `retry で通ったテスト (flaky): **${flaky.length} 件**。最終的には通ったが、1 回目は落ちている。main の run では \`${ISSUE_TITLE}\` の Issue に集める。`,
      ''
    );
    for (const f of flaky) lines.push(...flakyLines(f), '');
  }
  lines.push(...problemLines(problems));
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * 集約 Issue に追記する本文 (純関数)。追記するものが無ければ null (何もしない)。
 *
 * @param {Flaky[]} flaky 追記するもの (unreported を通した後)
 * @param {{ runId: string, runUrl: string, sha?: string, problems?: ReportProblem[] }} context
 */
export function formatIssueComment(flaky, { runId, runUrl, sha, problems = [] }) {
  if (flaky.length === 0) return null;
  const lines = [
    `## E2E の flaky: ${flaky.length} 件`,
    '',
    `- 実行: ${runUrl}`,
    ...(sha ? [`- 対象コミット: ${codeSpan(sha)}`] : []),
    '',
    '最終的には通ったが、1 回目は落ちている。根 (製品の競合 / テストの数え方 / 環境) を調べ、直すものは個別に起票する。',
    '',
  ];
  for (const f of flaky) lines.push(...flakyLines(f), markerOf(runId, f.key), '');
  lines.push(...problemLines(problems));
  return `${lines.join('\n').trimEnd()}\n`;
}

/** `--dir` の下の *.json を読む (CLI 専用)。無い・空・壊れているものは problems に入れる。 */
function readReports(dir) {
  if (!dir || !existsSync(dir)) {
    return { reports: [], missing: [{ source: dir ?? '(--dir 未指定)', reason: 'レポートのディレクトリが無い' }] };
  }
  const files = readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (files.length === 0) return { reports: [], missing: [{ source: dir, reason: 'JSON レポートが無い' }] };
  const reports = [];
  const missing = [];
  for (const file of files) {
    const path = join(dir, file);
    try {
      reports.push({ config: basename(file, '.json'), source: file, report: JSON.parse(readFileSync(path, 'utf8')) });
    } catch (error) {
      missing.push({ source: file, reason: `読めない: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return { reports, missing };
}

/** gh を実行して stdout を返す (CLI 専用)。 */
function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** `--name <value>` の値を返す。無ければ undefined。 */
function option(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`${name} には値を渡す`);
  return value;
}

/** job summary に書く (無ければ stdout)。 */
function writeSummary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  else process.stdout.write(markdown);
}

/** 集約 Issue に追記する (CLI 専用)。 */
function postToIssue(merged, problems) {
  const {
    GITHUB_SERVER_URL = 'https://github.com',
    GITHUB_REPOSITORY,
    GITHUB_RUN_ID,
    GITHUB_RUN_ATTEMPT,
  } = process.env;
  if (!GITHUB_REPOSITORY || !GITHUB_RUN_ID) throw new Error('GITHUB_REPOSITORY と GITHUB_RUN_ID が要る');
  const runUrl = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}${GITHUB_RUN_ATTEMPT ? `/attempts/${GITHUB_RUN_ATTEMPT}` : ''}`;

  if (merged.flaky.length === 0) {
    console.log('flaky は無い。何もしない。');
    return;
  }
  const issues = JSON.parse(gh(['issue', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title']));
  const existing = issues.find((issue) => issue.title === ISSUE_TITLE)?.number;
  let bodies = [];
  if (existing) {
    const view = JSON.parse(gh(['issue', 'view', String(existing), '--json', 'body,comments']));
    bodies = [view.body ?? '', ...(view.comments ?? []).map((c) => c.body ?? '')];
  }
  const fresh = unreported(merged.flaky, GITHUB_RUN_ID, bodies);
  const body = formatIssueComment(fresh, { runId: GITHUB_RUN_ID, runUrl, sha: process.env.GITHUB_SHA, problems });
  if (body === null) {
    console.log('この run の flaky は追記済み。何もしない。');
    return;
  }
  const file = join(process.env.RUNNER_TEMP || tmpdir(), `e2e-flaky-${GITHUB_RUN_ID}-${process.pid}.md`);
  writeFileSync(file, body);
  if (existing) {
    console.log(`既存 Issue #${existing} にコメント追記します (${fresh.length} 件)。`);
    gh(['issue', 'comment', String(existing), '--body-file', file]);
  } else {
    console.log(`新規 Issue を作成します (${fresh.length} 件)。`);
    gh(['issue', 'create', '--title', ISSUE_TITLE, '--body-file', file]);
  }
}

function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (command !== 'summary' && command !== 'issue') {
    console.error('使い方: node scripts/e2e-flaky.mjs <summary|issue> --dir <レポートのディレクトリ> [--label <名前>]');
    process.exitCode = 2;
    return;
  }
  let dir;
  let label;
  try {
    dir = option(argv, '--dir');
    label = option(argv, '--label');
  } catch (error) {
    console.error(`e2e-flaky: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
    return;
  }
  const { reports, missing } = readReports(dir);
  const merged = mergeReports(reports);
  const problems = [...missing, ...merged.problems];
  for (const p of problems) console.log(`::warning title=e2e-flaky::${p.source}: ${p.reason}`);
  for (const f of merged.flaky)
    console.log(`::warning title=e2e-flaky::${f.file}:${f.line} ${f.title} (retry で通った)`);
  writeSummary(formatSummary({ flaky: merged.flaky, problems }, { label }));

  if (command === 'issue') {
    try {
      postToIssue(merged, problems);
    } catch (error) {
      const detail = error?.stderr ? String(error.stderr).trim() : error instanceof Error ? error.message : error;
      console.error(`e2e-flaky: Issue に書けなかった: ${detail}`);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
