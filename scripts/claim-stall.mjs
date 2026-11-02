#!/usr/bin/env node
/**
 * 着手印の放置の検出 (#469) — `status: in progress` が付いたまま、参照する open PR も人の手も
 * 閾値 (既定 3 日) を超えて無い open Issue を名乗る。.github/workflows/claim-stall.yml が毎日呼び、
 * 検出があればジョブを赤くする (scheduled workflow の失敗通知でメンテナに届く)。
 *
 * 背景: 着手印を外す合図は「merge か中断」だけで (AGENTS.md「Issue と着手」)、Issue を閉じない
 * PR のマージや追跡 Issue に付けた印では外す契機が無い。2026-11-03 に #346 (追跡 Issue) と #344 が、
 * 作業者のいないまま印を残していた。close 時に外す仕組み (#380) は見送り済みで、open のまま残る
 * 今回の型には効かない。判定は mokume の stale-claim (mokume#3366。ready-queue.sh の dropped) に倣う。
 *
 * **印は外さず、起票もしない**。中断中の作業と区別できないので、閉じる・印を外して残作業を
 * コメントする・プランを更新して人の手を残す、は人かエージェントの仕事。
 *
 * ルール (窓 = `now - thresholdDays` から now まで):
 *   - 対象 = open かつ `status: in progress` の付いた Issue
 *   - 次のどれかがあれば生きているとみなし、検出しない
 *       1. その Issue を参照する open PR — `closingIssuesReferences` に番号がある、または PR 本文に
 *          `#N` が語境界つきで現れる (`#3` は `#346` に当たらない。`owner/repo#N` は別リポなので数えない)
 *       2. Issue 自身が窓の中で動いている (下の「動き」)
 *       3. 子 Issue (subIssues) のどれかに 1 か 2 がある。追跡 Issue は子で作業が進んでも自分の
 *          updatedAt が動かないため。**家族を渡るのは子の 1 段だけ** (孫や、子を通じて生きた兄弟は数えない)
 *   - 動き: 基準は `updatedAt`。窓より前なら静か。窓の中なら、次を**すべて**満たすときだけ静かとみなす
 *     (bot と分かる手だけを除き、それ以外は人の手に倒す):
 *       - `lastEditedAt` (本文の編集) が窓より前
 *       - 窓の timelineItems が 1 件以上あり、窓の全件を引けている (filteredCount ≦ 引けた件数)
 *       - その全件の actor / author の `__typename` が `Bot`
 *     窓が空なのに updatedAt が新しいのは、timeline に出ない動き (既存コメントの編集など) が
 *     updatedAt を動かしたときで、それが人の手でないとは言えないので動いているとみなす
 *   - 境界: 経過が閾値を **超え** たら静か (ちょうど閾値は動いている側。release-stall と揃える)。
 *     ただし日数の切り捨てはせずミリ秒で比べる — 問い合わせの窓 (`since`) と同じ物差しにするためと、
 *     閾値 0 日の手動確認で「いま印の付いている Issue」を検出させるため
 *
 * 判定 (evaluateClaimStall) と GraphQL の応答の整形 (normalizeClaimData) は純関数。`gh` の呼び出しは
 * CLI 部分 (main) に閉じる。問い合わせは GraphQL 1 回 (印付き Issue + その子 + open PR)。
 *
 * 使い方:
 *   node scripts/claim-stall.mjs                      # 結果の JSON を stdout へ
 *   node scripts/claim-stall.mjs --threshold-days 0   # 閾値を変える (> CLAIM_STALL_DAYS > 既定 3)
 *
 * repo は GITHUB_REPOSITORY、無ければ `gh repo view` から取る。GITHUB_STEP_SUMMARY があれば検出一覧と
 * 対処を Markdown で追記し、検出ごとに `::warning title=stale-claim::` を出す。
 * exit 0 = 検出なし / 1 = 検出あり / 2 = 読めなかった (gh の失敗・GraphQL のエラー・取りこぼし・引数の誤り)。
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 着手印のラベル名。AGENTS.md「ラベル」と揃える。 */
export const CLAIM_LABEL = 'status: in progress';
/** 放置とみなす日数 (これを超えたら)。#469 の既定。 */
export const CLAIM_STALL_THRESHOLD_DAYS = 3;
/** 検出したときの対処。run の要約にそのまま載せる。 */
export const REMEDIES = [
  '終わっているなら Issue を閉じる',
  '中断したなら印を外し、残作業 (完了・残作業・注意点・次の一歩) をコメントする',
  '続けているならプランを更新するなどして人の手を残す',
];

/** 1 回の問い合わせで引く件数。超えたら取りこぼしとして exit 2 にする (黙って欠けた判定をしない)。 */
const ISSUE_PAGE = 50;
const SUB_ISSUE_PAGE = 25;
const TIMELINE_PAGE = 50;
const PR_PAGE = 100;
const CLOSING_PAGE = 25;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * actor を持つ timeline の項目の型。ここに無い型の項目は作者が引けず、人の手に倒れる (安全側)。
 * mokume の scripts/bot-hand.sh の一覧から、Issue の timeline に現れうるものを取った。Projects の項目
 * (`*ProjectV2*Event`) は外している — 読むのに `read:project` が要り、workflow の GITHUB_TOKEN にも手元の
 * gh の既定のトークンにも無いので、問い合わせごと失敗する (2026-11-03 に手元で確かめた)。
 */
const ACTOR_TYPES = [
  'AssignedEvent',
  'ClosedEvent',
  'CommentDeletedEvent',
  'ConnectedEvent',
  'CrossReferencedEvent',
  'DemilestonedEvent',
  'DisconnectedEvent',
  'IssueTypeAddedEvent',
  'IssueTypeChangedEvent',
  'IssueTypeRemovedEvent',
  'LabeledEvent',
  'LockedEvent',
  'MarkedAsDuplicateEvent',
  'MentionedEvent',
  'MilestonedEvent',
  'ParentIssueAddedEvent',
  'ParentIssueRemovedEvent',
  'PinnedEvent',
  'ReferencedEvent',
  'RenamedTitleEvent',
  'ReopenedEvent',
  'SubIssueAddedEvent',
  'SubIssueRemovedEvent',
  'SubscribedEvent',
  'TransferredEvent',
  'UnassignedEvent',
  'UnlabeledEvent',
  'UnlockedEvent',
  'UnmarkedAsDuplicateEvent',
  'UnpinnedEvent',
  'UnsubscribedEvent',
];

/**
 * @typedef {{ actorType: string | null, createdAt?: string | null }} TimelineHand
 *   actorType = actor / author の `__typename` (`Bot` / `User` など)。引けなければ null (人の手に倒す)
 * @typedef {{
 *   number: number,
 *   title?: string,
 *   state?: string,
 *   labels?: string[],
 *   updatedAt: string,
 *   lastEditedAt?: string | null,
 *   windowItems?: TimelineHand[],
 *   windowTotal?: number,
 *   subIssues?: ClaimIssue[],
 * }} ClaimIssue
 *   windowItems = 窓 (since) の timelineItems から引けた項目、windowTotal = 窓の中の全件 (filteredCount)
 * @typedef {{ number: number, body?: string | null, closingIssues?: number[] }} OpenPr
 */

/** PR 本文が `#N` を語境界つきで含むか (`#3` は `#346` に、`owner/repo#3` は別リポなので当たらない)。 */
export function mentionsIssue(body, number) {
  if (!body) return false;
  return new RegExp(`(?<![\\w/#])#${number}(?!\\w)`).test(body);
}

/**
 * 1 件の Issue (または子) が窓の中で人の手で動いているか。
 *
 * @param {ClaimIssue} issue
 * @param {number} sinceMs 窓の始まり (now - 閾値)
 */
function movedInWindow(issue, sinceMs) {
  const updated = Date.parse(issue.updatedAt);
  if (Number.isNaN(updated)) throw new Error(`#${issue.number} の updatedAt が日時として読めない`);
  if (updated < sinceMs) return false;
  if (issue.lastEditedAt && Date.parse(issue.lastEditedAt) >= sinceMs) return true;

  const fetched = issue.windowItems ?? [];
  // 窓の外の項目が混じっていても数えない (CLI は since で絞って引くので通常は混じらない)
  const items = fetched.filter((item) => !item.createdAt || Date.parse(item.createdAt) >= sinceMs);
  if ((issue.windowTotal ?? fetched.length) > fetched.length) return true; // 引けていない項目がある
  if (items.length === 0) return true; // 窓が空なのに updatedAt が新しい
  return items.some((item) => item.actorType !== 'Bot');
}

/**
 * 着手印の放置の判定 (純関数)。
 *
 * @param {{ issues: ClaimIssue[], openPrs: OpenPr[], now: Date | string, thresholdDays?: number }} input
 * @returns {{
 *   stalled: { number: number, title: string, updatedAt: string, botOnly: boolean }[],
 *   checked: number,
 *   thresholdDays: number,
 *   since: string,
 * }}
 *   botOnly = updatedAt は窓の中だが、窓の中の手がすべて Bot だった (最後の人の手は窓より前)
 */
export function evaluateClaimStall({ issues, openPrs, now, thresholdDays = CLAIM_STALL_THRESHOLD_DAYS }) {
  if (!Number.isFinite(thresholdDays) || thresholdDays < 0) throw new Error('thresholdDays は 0 以上の数');
  const nowMs = new Date(now).getTime();
  if (Number.isNaN(nowMs)) throw new Error('now が日時として読めない');
  const sinceMs = nowMs - thresholdDays * MS_PER_DAY;

  /** @param {ClaimIssue} issue */
  const referencedByOpenPr = (issue) =>
    openPrs.some((pr) => (pr.closingIssues ?? []).includes(issue.number) || mentionsIssue(pr.body, issue.number));
  /** @param {ClaimIssue} issue */
  const alive = (issue) => referencedByOpenPr(issue) || movedInWindow(issue, sinceMs);

  const claimed = issues.filter(
    (issue) => (issue.state ?? 'OPEN').toUpperCase() === 'OPEN' && (issue.labels ?? []).includes(CLAIM_LABEL)
  );
  const stalled = claimed
    // 子は 1 段だけ。子の alive は子自身の証拠 (PR・動き) だけで決まり、孫は見ない
    .filter((issue) => !alive(issue) && !(issue.subIssues ?? []).some(alive))
    .map((issue) => ({
      number: issue.number,
      title: issue.title ?? '',
      updatedAt: issue.updatedAt,
      botOnly: Date.parse(issue.updatedAt) >= sinceMs,
    }));

  return { stalled, checked: claimed.length, thresholdDays, since: new Date(sinceMs).toISOString() };
}

/** timeline の項目から作者の型を取る。actor / author のどちらも無ければ null。 */
function handOf(node) {
  const who = node?.author ?? node?.actor ?? null;
  return { actorType: who?.__typename ?? null, createdAt: node?.createdAt ?? null };
}

/** GraphQL の Issue ノードを ClaimIssue にする (子にも使う)。 */
function toClaimIssue(node) {
  const timeline = node.timelineItems ?? { filteredCount: 0, nodes: [] };
  const nodes = timeline.nodes ?? [];
  return {
    number: node.number,
    title: node.title,
    state: node.state,
    labels: (node.labels?.nodes ?? []).map((label) => label.name),
    updatedAt: node.updatedAt,
    lastEditedAt: node.lastEditedAt ?? null,
    windowItems: nodes.map(handOf),
    windowTotal: timeline.filteredCount ?? nodes.length,
    subIssues: (node.subIssues?.nodes ?? []).map(toClaimIssue),
  };
}

/**
 * `buildQuery` の応答を判定の入力にする (純関数)。取りこぼし (次のページがある) は例外にする —
 * 欠けた入力で「放置なし」と言わないため。
 *
 * @returns {{ issues: ClaimIssue[], openPrs: OpenPr[] }}
 */
export function normalizeClaimData(response) {
  if (response?.errors?.length)
    throw new Error(`GraphQL のエラー: ${response.errors.map((e) => e.message).join('; ')}`);
  const repository = response?.data?.repository;
  if (!repository) throw new Error('GraphQL の応答に repository が無い');
  const { issues, pullRequests } = repository;
  if (issues.pageInfo?.hasNextPage) throw new Error(`印付きの Issue が ${ISSUE_PAGE} 件を超えた (取りこぼし)`);
  if (pullRequests.pageInfo?.hasNextPage) throw new Error(`open PR が ${PR_PAGE} 件を超えた (取りこぼし)`);
  for (const issue of issues.nodes) {
    if (issue.subIssues?.pageInfo?.hasNextPage) {
      throw new Error(`#${issue.number} の子 Issue が ${SUB_ISSUE_PAGE} 件を超えた (取りこぼし)`);
    }
  }
  return {
    issues: issues.nodes.map(toClaimIssue),
    openPrs: pullRequests.nodes.map((pr) => ({
      number: pr.number,
      body: pr.body ?? '',
      closingIssues: (pr.closingIssuesReferences?.nodes ?? []).map((ref) => ref.number),
    })),
  };
}

/** 印付きの open Issue (と子 1 段) と open PR を 1 回で引く問い合わせ。 */
export function buildQuery() {
  const hand = [
    '__typename',
    '... on IssueComment { createdAt author { __typename } }',
    ...ACTOR_TYPES.map((type) => `... on ${type} { createdAt actor { __typename } }`),
  ].join(' ');
  const window = `timelineItems(since: $since, last: ${TIMELINE_PAGE}) { filteredCount nodes { ${hand} } }`;
  return `query($owner: String!, $name: String!, $label: String!, $since: DateTime!) {
  repository(owner: $owner, name: $name) {
    issues(labels: [$label], states: OPEN, first: ${ISSUE_PAGE}) {
      pageInfo { hasNextPage }
      nodes {
        number title state updatedAt lastEditedAt
        labels(first: 50) { nodes { name } }
        ${window}
        subIssues(first: ${SUB_ISSUE_PAGE}) {
          pageInfo { hasNextPage }
          nodes { number title state updatedAt lastEditedAt ${window} }
        }
      }
    }
    pullRequests(states: OPEN, first: ${PR_PAGE}) {
      pageInfo { hasNextPage }
      nodes { number body closingIssuesReferences(first: ${CLOSING_PAGE}) { nodes { number } } }
    }
  }
}`;
}

/**
 * run の要約 (Markdown)。
 *
 * @param {ReturnType<typeof evaluateClaimStall>} result
 * @param {{ repo?: string, serverUrl?: string }} context
 */
export function formatSummary(result, { repo, serverUrl = 'https://github.com' } = {}) {
  const link = (number) => (repo ? `[#${number}](${serverUrl}/${repo}/issues/${number})` : `#${number}`);
  const lines = [
    '## 着手印の放置 (stale-claim)',
    '',
    `\`${CLAIM_LABEL}\` の付いた open Issue ${result.checked} 件のうち、参照する open PR も人の手も ${result.thresholdDays} 日を超えて無いもの: **${result.stalled.length} 件**`,
  ];
  if (result.stalled.length > 0) {
    lines.push('', '| Issue | タイトル | 最後の更新 |', '|---|---|---|');
    for (const issue of result.stalled) {
      const updated = `${issue.updatedAt}${issue.botOnly ? ' (以降は bot の手だけ)' : ''}`;
      lines.push(`| ${link(issue.number)} | ${issue.title.replaceAll('|', '\\|')} | ${updated} |`);
    }
    lines.push('', '対処 (印はこのワークフローでは外さない):', '', ...REMEDIES.map((remedy) => `- ${remedy}`));
  }
  return `${lines.join('\n')}\n`;
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

/** 閾値の日数: `--threshold-days` > CLAIM_STALL_DAYS > 既定。 */
function resolveThresholdDays(argv) {
  const raw = option(argv, '--threshold-days') ?? process.env.CLAIM_STALL_DAYS;
  if (raw === undefined || raw === '') return CLAIM_STALL_THRESHOLD_DAYS;
  const days = Number(raw);
  if (!Number.isFinite(days) || days < 0) throw new Error(`閾値の日数は 0 以上の数: ${raw}`);
  return days;
}

function main() {
  const argv = process.argv.slice(2);
  let result;
  let repo;
  try {
    const thresholdDays = resolveThresholdDays(argv);
    repo = process.env.GITHUB_REPOSITORY || gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
    const [owner, name] = repo.split('/');
    const now = new Date();
    const since = new Date(now.getTime() - thresholdDays * MS_PER_DAY).toISOString();
    const raw = gh([
      'api',
      'graphql',
      '-f',
      `query=${buildQuery()}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-f',
      `label=${CLAIM_LABEL}`,
      '-f',
      `since=${since}`,
    ]);
    result = evaluateClaimStall({ ...normalizeClaimData(JSON.parse(raw)), now, thresholdDays });
  } catch (error) {
    const detail = error?.stderr ? String(error.stderr).trim() : error instanceof Error ? error.message : error;
    console.error(`claim-stall: 読めなかった: ${detail}`);
    process.exitCode = 2;
    return;
  }

  console.log(JSON.stringify(result, null, 2));
  for (const issue of result.stalled) {
    console.log(
      `::warning title=stale-claim::#${issue.number} ${issue.title} — 参照する open PR も人の手も ${result.thresholdDays} 日を超えて無い`
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      formatSummary(result, { repo, serverUrl: process.env.GITHUB_SERVER_URL })
    );
  }
  process.exitCode = result.stalled.length > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
