#!/usr/bin/env node
/**
 * カバレッジの床を「上げられる値」の知らせ (#472) — main で `npm run coverage:ratchet` を回した結果、
 * 各パッケージの `vitest.config.ts` の `coverage.thresholds` に出た差分 (パッケージと指標ごとの
 * 「今の床 → 上げられる値」) を読み、Issue 本文にする。.github/workflows/coverage-ratchet.yml が週 1 回呼ぶ。
 *
 * 背景: 機能 PR の作者が手元でラチェットすると、手元と CI の実測のずれで床割れ (#463) や、並行 PR の
 * `vitest.config.ts` の同じ行の衝突が起きる。そこで機能 PR では床を動かさず、CI と同じ環境の main で
 * 測る定期ジョブが「ここまで上げられる」を Issue で知らせ、床を上げる専用の PR は人かエージェントが出す。
 * PR までは自動で開かない (GITHUB_TOKEN で開いた PR には pull_request の CI が走らず、App / PAT を
 * 登録する運用は採らないと決めた)。
 *
 * ルール:
 *   - 入力は `git diff -U0 -- packages/` の `vitest.config.ts` の差分。`+++ b/packages/<pkg>/vitest.config.ts` で
 *     パッケージを決め、`-`/`+` の `<指標>: <数値>,` の行を指標ごとに突き合わせる
 *   - 指標は lines / functions / branches / statements だけ。他の行 (autoUpdate など) は無視する
 *   - **上げる向きの差分だけ**を「上げられる値」にする。床が下がる向き (21 → 20) や同値は知らせない
 *     (ラチェットは床を上げるだけの道具で、下がる差分は想定外なので、人に床を下げさせる知らせにしない)
 *   - 上げられる値が 1 件も無ければ「知らせない」
 *
 * 判定 (parseFloorChanges / evaluateCoverageRatchet) と本文の組み立て (formatIssueBody) は純関数。
 * ファイルの読み書きは CLI 部分 (main) に閉じる。
 *
 * 使い方:
 *   node scripts/coverage-ratchet.mjs --diff-file ratchet.diff                    # 結果の JSON を stdout へ
 *   node scripts/coverage-ratchet.mjs --diff-file ratchet.diff --body-file out.md # 知らせるときは本文も書き出す
 *
 * GITHUB_OUTPUT があれば `notify` / `count` を書く。知らせるときも exit 0 (検知は PR を止めるゲートではない)。
 * exit 2 = 入力が読めない。
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 専用 Issue のタイトル。同タイトルの open Issue があれば workflow はコメント追記に切り替える。 */
export const ISSUE_TITLE = 'chore: カバレッジの床を上げられる (自動)';
/** 床の指標。表示順もこの順。 */
export const METRICS = ['lines', 'functions', 'branches', 'statements'];

const FLOOR_LINE = /^[-+]\s*(lines|functions|branches|statements):\s*(\d+(?:\.\d+)?),?\s*$/;
const FILE_HEADER = /^\+\+\+ b\/packages\/([^/]+)\/vitest\.config\.ts\s*$/;

/**
 * `git diff -U0` の出力から、パッケージ・指標ごとの床の変化を読む (純関数)。
 * 下がる向き・同値も含めて返す (向きの判断は evaluateCoverageRatchet)。
 *
 * @param {string} diffText
 * @returns {{ pkg: string, metric: string, from: number, to: number }[]}
 */
export function parseFloorChanges(diffText) {
  /** @type {Map<string, { before: Map<string, number>, after: Map<string, number> }>} */
  const byPackage = new Map();
  let current = null;
  for (const line of diffText.split('\n')) {
    const header = FILE_HEADER.exec(line);
    if (header) {
      if (!byPackage.has(header[1])) byPackage.set(header[1], { before: new Map(), after: new Map() });
      current = byPackage.get(header[1]);
      continue;
    }
    if (line.startsWith('diff --git ')) {
      current = null; // 次のファイルの `+++` まで、対象外のファイルの行を拾わない
      continue;
    }
    if (!current) continue;
    const floor = FLOOR_LINE.exec(line);
    if (!floor) continue;
    (line.startsWith('-') ? current.before : current.after).set(floor[1], Number(floor[2]));
  }

  const changes = [];
  for (const [pkg, { before, after }] of [...byPackage].sort(([a], [b]) => a.localeCompare(b))) {
    for (const metric of METRICS) {
      if (before.has(metric) && after.has(metric)) {
        changes.push({ pkg, metric, from: before.get(metric), to: after.get(metric) });
      }
    }
  }
  return changes;
}

/**
 * 知らせるかどうかの判定 (純関数)。上げる向きの変化だけを `raises` に残す。
 *
 * @param {string} diffText
 * @returns {{ notify: boolean, count: number, raises: ReturnType<typeof parseFloorChanges> }}
 */
export function evaluateCoverageRatchet(diffText) {
  const raises = parseFloorChanges(diffText).filter((change) => change.to > change.from);
  return { notify: raises.length > 0, count: raises.length, raises };
}

/**
 * 専用 Issue の本文 (Markdown)。新規作成にも、既存 Issue へのコメント追記にもそのまま使う。
 *
 * @param {ReturnType<typeof evaluateCoverageRatchet>['raises']} raises
 * @param {{ sha?: string, repo?: string, serverUrl?: string, runId?: string }} [context]
 */
export function formatIssueBody(raises, { sha, repo, serverUrl = 'https://github.com', runId } = {}) {
  const base = repo ? `${serverUrl}/${repo}` : '';
  const packages = [...new Set(raises.map((r) => r.pkg))];
  const lines = [
    `**要約**: main で \`npm run coverage:ratchet\` を回したところ、カバレッジの床を ${packages.length} パッケージ・${raises.length} 指標で上げられます。`,
    '',
    '**人が判断すること**: 床を上げる専用の PR を出すか決める (出すなら下の手順。見送るならこのコメントは無視してよい)。',
    '',
    '| パッケージ | 指標 | 今の床 → 上げられる値 |',
    '|---|---|---|',
    ...raises.map((r) => `| \`${r.pkg}\` | \`${r.metric}\` | ${r.from} → ${r.to} |`),
    '',
  ];
  if (sha) lines.push(`- 対象コミット: \`${sha}\``);
  if (base && runId) lines.push(`- 実行: [\`${runId}\`](${base}/actions/runs/${runId})`);
  lines.push(
    '',
    '値は main の CI と同じ環境での実測を切り捨てたもの。**最新のコメントが現在の値**で、古いコメントの値は使わない。',
    '',
    '床を上げる手順 (機能 PR とは別の、専用の PR で行う。ADR-0034 / CONTRIBUTING.md「完了の定義」):',
    '',
    '1. 最新の main から worktree を切る',
    '2. 表の値を各パッケージの `vitest.config.ts` の `coverage.thresholds` に書いてコミットする (手元の `npm run coverage:ratchet` は手元の実測で床を決めるので、CI の実測を上回りうる。この表の値を使う)',
    '3. その PR の CI (test job) が緑なら、CI 上の実測で床を超えていることが確かめられる。赤なら、床が CI の実測を上回っているので、割れた指標だけ値を 1 下げて push し直す (同じソースでも実測が揺れる件は #495)',
    '',
    '---',
    '<sub>自動検知: .github/workflows/coverage-ratchet.yml / scripts/coverage-ratchet.mjs (#472)</sub>'
  );
  return `${lines.join('\n')}\n`;
}

/** `--name <value>` の値を返す。無ければ undefined。 */
function option(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`${name} には値を渡す`);
  return value;
}

function main() {
  const argv = process.argv.slice(2);
  let result;
  try {
    const diffFile = option(argv, '--diff-file');
    if (!diffFile) throw new Error('--diff-file が要る');
    const bodyFile = option(argv, '--body-file');
    result = evaluateCoverageRatchet(readFileSync(diffFile, 'utf8'));
    if (result.notify && bodyFile) {
      writeFileSync(
        bodyFile,
        formatIssueBody(result.raises, {
          sha: process.env.GITHUB_SHA,
          repo: process.env.GITHUB_REPOSITORY,
          serverUrl: process.env.GITHUB_SERVER_URL,
          runId: process.env.GITHUB_RUN_ID,
        })
      );
    }
  } catch (error) {
    console.error(`coverage-ratchet: 入力エラー: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
    return;
  }

  console.log(JSON.stringify(result, null, 2));
  console.log(
    result.notify
      ? `coverage-ratchet: 床を上げられる指標が ${result.count} 件ある`
      : 'coverage-ratchet: 上げられる床は無い。何もしない'
  );
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `notify=${result.notify}\ncount=${result.count}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
