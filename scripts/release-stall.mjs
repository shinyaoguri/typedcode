#!/usr/bin/env node
/**
 * 本番リリースの停滞検知 (#410) — 最新の `v*` タグから日数が経ち、かつ未リリースの fix / feat が
 * あるかを判定する。.github/workflows/freshness.yml が週次で呼び、検知したら専用 Issue を開く。
 *
 * 背景: タグ式 GitHub Flow (ADR-0028) では「タグを打つ」までが人の手で、忘れても誰も気付かない。
 * 同じ停滞が #85 と #332 で 2 回起きたので、文書の規則に加えて機械で検知する。
 *
 * ルール:
 *   - 経過日数 = 最新タグの日時から now までの「満日数」(切り捨て)。30 日 23 時間でも 30 日と数える
 *   - 件数 = タグ以降 (`<tag>..HEAD`) のコミット件名のうち `^(fix|feat)(\(.+\))?!?:` に合うもの。
 *     破壊的変更の `!` も数える。docs / chore / ci / test / refactor だけの停滞は利用者に届く差が無いので数えない
 *   - 検知 = 経過日数が閾値 (既定 30) を **超え** (ちょうど 30 日は検知しない)、かつ件数が 1 以上
 *
 * 判定 (evaluateReleaseStall) は純関数。git の呼び出しは CLI 部分 (main) に閉じる。
 *
 * 使い方:
 *   node scripts/release-stall.mjs                      # 結果の JSON を stdout へ
 *   node scripts/release-stall.mjs --body-file out.md   # 検知時に Issue 本文 (Markdown) も書き出す
 *   node scripts/release-stall.mjs --ref origin/main    # 調べる ref (既定 HEAD)
 *
 * GITHUB_OUTPUT があれば `stalled` / `tag` / `days` / `count` を書く。検知しても exit 0
 * (検知は PR を止めるゲートではない)。exit 2 = git が使えないなどの入力エラー。
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 停滞とみなす日数 (これを超えたら)。CONTRIBUTING.md「リリース」と揃える。 */
export const STALL_THRESHOLD_DAYS = 30;
/** 専用 Issue のタイトル。同タイトルの open Issue があれば workflow はコメント追記に切り替える。 */
export const ISSUE_TITLE = 'chore: 本番リリースの停滞 (自動)';
/** 利用者に届く変更 (fix / feat。破壊的変更の `!` を含む) のコミット件名。 */
export const RELEASE_SUBJECT = /^(fix|feat)(\(.+\))?!?:/;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Issue 本文に一覧する件名の上限。超えたぶんは件数だけ書く。 */
const MAX_LISTED = 100;

/**
 * 停滞の判定 (純関数)。
 *
 * @param {{ tagDate: Date | string, now: Date | string, subjects: string[], thresholdDays?: number }} input
 * @returns {{ stalled: boolean, days: number, count: number, matches: string[], thresholdDays: number }}
 */
export function evaluateReleaseStall({ tagDate, now, subjects, thresholdDays = STALL_THRESHOLD_DAYS }) {
  const elapsed = new Date(now).getTime() - new Date(tagDate).getTime();
  if (Number.isNaN(elapsed)) throw new Error('tagDate / now が日時として読めない');
  const days = Math.floor(elapsed / MS_PER_DAY);
  const matches = subjects.filter((subject) => RELEASE_SUBJECT.test(subject));
  return {
    stalled: days > thresholdDays && matches.length >= 1,
    days,
    count: matches.length,
    matches,
    thresholdDays,
  };
}

/**
 * 専用 Issue の本文 (Markdown)。新規作成にも、既存 Issue へのコメント追記にもそのまま使う。
 *
 * @param {ReturnType<typeof evaluateReleaseStall>} result
 * @param {{ tag: string, tagDate: Date | string, sha?: string, repo?: string, serverUrl?: string, runId?: string }} context
 */
export function formatIssueBody(result, { tag, tagDate, sha, repo, serverUrl = 'https://github.com', runId }) {
  const base = repo ? `${serverUrl}/${repo}` : '';
  const guide = base ? `${base}/blob/main/CONTRIBUTING.md#リリース-v-タグ` : 'CONTRIBUTING.md';
  const listed = result.matches.slice(0, MAX_LISTED).map((subject) => `- ${subject}`);
  if (result.matches.length > MAX_LISTED) listed.push(`- ほか ${result.matches.length - MAX_LISTED} 件`);

  const lines = [
    `**要約**: 最新の本番タグ \`${tag}\` から ${result.days} 日が経ち、未リリースの fix / feat が ${result.count} 件あります (検知の閾値は ${result.thresholdDays} 日超)。`,
    '',
    '**人が判断すること**: リリースするか、見送るならその理由をこの Issue にコメントする。',
    '',
    `- 最新タグ: \`${tag}\` (${new Date(tagDate).toISOString().slice(0, 10)})`,
    `- 経過日数: ${result.days} 日`,
    `- 未リリースの fix / feat: ${result.count} 件`,
  ];
  if (base && runId) lines.push(`- 実行: [\`${runId}\`](${base}/actions/runs/${runId})`);
  if (sha) lines.push(`- 対象コミット: \`${sha}\``);
  lines.push(
    '',
    `手順は [CONTRIBUTING.md「リリース」](${guide}) (バージョン bump PR → \`gh release create\` → Actions で production を Approve)。`,
    '',
    `<details><summary>未リリースの fix / feat (${result.count} 件)</summary>`,
    '',
    ...listed,
    '',
    '</details>',
    '',
    '---',
    '<sub>自動検知: .github/workflows/freshness.yml / scripts/release-stall.mjs (#410)</sub>'
  );
  return `${lines.join('\n')}\n`;
}

/** git を実行して stdout を返す (CLI 専用)。 */
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/** `--name <value>` の値を返す。無ければ undefined。 */
function option(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`${name} には値を渡す`);
  return value;
}

/** 調べる ref から到達できる最新の `v*` タグ。無ければ null。 */
function latestTag(ref) {
  try {
    return git(['describe', '--tags', '--abbrev=0', '--match', 'v*', ref]);
  } catch {
    return null;
  }
}

function main() {
  const argv = process.argv.slice(2);
  let output;
  try {
    const ref = option(argv, '--ref') ?? 'HEAD';
    const bodyFile = option(argv, '--body-file');
    const tag = latestTag(ref);

    if (tag === null) {
      output = { stalled: false, tag: null, days: 0, count: 0, reason: 'v* タグが無い' };
    } else {
      // creatordate = 注釈付きタグはタグ付け日時、軽量タグ (gh release create) は指すコミットの日時
      const tagDate = git(['for-each-ref', '--format=%(creatordate:iso-strict)', `refs/tags/${tag}`]);
      const subjects = git(['log', `${tag}..${ref}`, '--format=%s'])
        .split('\n')
        .filter(Boolean);
      const result = evaluateReleaseStall({ tagDate, now: new Date(), subjects });
      output = { tag, tagDate, ...result };
      if (result.stalled && bodyFile) {
        writeFileSync(
          bodyFile,
          formatIssueBody(result, {
            tag,
            tagDate,
            sha: process.env.GITHUB_SHA,
            repo: process.env.GITHUB_REPOSITORY,
            serverUrl: process.env.GITHUB_SERVER_URL,
            runId: process.env.GITHUB_RUN_ID,
          })
        );
      }
    }
  } catch (error) {
    console.error(`release-stall: 入力エラー: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
    return;
  }

  const { matches, ...summary } = output;
  console.log(JSON.stringify(summary, null, 2));
  if (output.stalled) {
    console.log(`release-stall: 検知 (${output.tag} から ${output.days} 日、fix / feat ${output.count} 件)`);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `stalled=${output.stalled}\ntag=${output.tag ?? ''}\ndays=${output.days}\ncount=${output.count}\n`
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
