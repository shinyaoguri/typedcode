#!/usr/bin/env node
/**
 * Issue の紐づけゲート (ADR-0038, #478) — PR が自リポジトリの Issue を閉じるかを判定する。
 *
 * PR テンプレートは `### Closes #N` を案内するが、検査が無いと閉じ忘れが残る。実害: #226 は
 * 受け入れ条件 4 項目を #402 で満たしたのに、PR が「後続が残る」として `Refs` にしたため open の
 * まま残った。段階に分けた PR が `Refs` で親 Issue を開いたまま積み、残作業の所在が親のコメントに
 * 散らばる形も繰り返している。merge 前に、紐づけの欠落を機械で止める。
 *
 * 判定は **PR 本文の文字列ではなく、GitHub が実際に作った紐づけ (`closingIssuesReferences`)** を
 * 読む。コードスパン・引用・打ち消しの中の `Closes #N` は GitHub が紐づけないので、本文を正規表現で
 * 照合すると「書いたのに閉じない」PR が通ってしまう。mokume の `scripts/review-gate.sh` も同じ理由で
 * closingIssuesReferences を読んでいる。
 *
 * require-tests / require-visual-evidence (見るファイルを含まない PR に限ってタイトルの型で免除する) と違い、
 * **タイトルの型 (docs / ci / chore) では一切免除しない** (require-tests.mjs の exemptionReason は使わない)。閉じ忘れは docs / ci / chore の PR にもあり、
 * 型で免除すると Issue を閉じる責務ごと抜ける。受け入れ条件を持たない PR (依存の手動更新・
 * リリース準備など) はラベルで通す。
 *
 * ルール:
 *   - author が dependabot[bot] → pass (依存更新は Issue から始まらない)
 *   - ラベル `no-issue` → pass
 *   - closingIssuesReferences に自リポジトリ (owner/name が GITHUB_REPOSITORY と一致。大文字小文字は
 *     区別しない) の Issue が 1 件以上 → pass
 *   - それ以外 → fail (他リポジトリの Issue だけを閉じる PR も fail)
 *
 * 使い方 (CI は .github/workflows/pr-checks.yml):
 *   gh pr view N --json title,body,labels,author,closingIssuesReferences > pr.json
 *   GITHUB_REPOSITORY=owner/repo node scripts/require-issue.mjs --pr pr.json --closing pr.json
 *
 * 入力:
 *   PR の現在値       — `--pr <path>`: `gh pr view --json title,body,labels,author` の出力 JSON (必須)。
 *                       ラベル・author を event payload ではなく実行時点の PR から読む (#632。読み方は
 *                       require-tests.mjs の readPr)
 *   GITHUB_REPOSITORY — owner/repo (Actions が設定する。未設定なら入力エラー)
 *   紐づけ             — `--closing <path>`: `gh pr view --json closingIssuesReferences` の出力 JSON。
 *                       `--pr` と同じ 1 回の gh pr view の出力 (同じファイル) を渡してよい
 *                       (例: '{"closingIssuesReferences":[{"number":1,"repository":{"name":"typedcode",
 *                       "owner":{"login":"shinyaoguri"}}}]}')
 *
 * exit 0 = pass / 1 = 紐づけなし / 2 = 入力エラー
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { escapeAnnotation, readPr } from './require-tests.mjs';

/** 逃げ道のラベル名。CONTRIBUTING.md / PR テンプレートと揃える。 */
export const NO_ISSUE_LABEL = 'no-issue';
/** 免除する author (依存更新の bot)。 */
const DEPENDABOT = 'dependabot[bot]';

/** closing ref が repo (owner/name) の Issue か。大文字小文字は区別しない。 */
function isOwnRepo(ref, repo) {
  const owner = ref?.repository?.owner?.login;
  const name = ref?.repository?.name;
  if (typeof owner !== 'string' || typeof name !== 'string') return false;
  return `${owner}/${name}`.toLowerCase() === repo.toLowerCase();
}

/**
 * ゲートの判定 (純関数)。
 *
 * @param {{ closing: Array<{ number: number, repository?: { name?: string, owner?: { login?: string } } }>,
 *           labels?: string[], author?: string, repo: string }} pr
 * @returns {{ ok: boolean, verdict: 'dependabot' | 'waived' | 'closes-issue' | 'missing-issue',
 *             detail: string, ownIssues: number[], foreignRefs: string[] }}
 */
export function evaluate({ closing, labels = [], author = '', repo }) {
  const own = closing.filter((ref) => isOwnRepo(ref, repo));
  const ownIssues = own.map((ref) => ref.number);
  const foreignRefs = closing
    .filter((ref) => !isOwnRepo(ref, repo))
    .map((ref) => `${ref?.repository?.owner?.login ?? '?'}/${ref?.repository?.name ?? '?'}#${ref?.number ?? '?'}`);
  const result = (ok, verdict, detail) => ({ ok, verdict, detail, ownIssues, foreignRefs });

  if (author === DEPENDABOT) return result(true, 'dependabot', `対象外: author が ${DEPENDABOT}`);
  if (labels.includes(NO_ISSUE_LABEL)) return result(true, 'waived', `ラベル ${NO_ISSUE_LABEL} あり`);
  if (ownIssues.length > 0) {
    return result(true, 'closes-issue', `閉じる Issue: ${ownIssues.map((n) => `#${n}`).join(', ')}`);
  }
  if (foreignRefs.length > 0) {
    return result(false, 'missing-issue', `他リポジトリの Issue (${foreignRefs.join(', ')}) しか閉じていない`);
  }
  return result(false, 'missing-issue', 'この PR はどの Issue も閉じていない');
}

/** fail 時に人間へ見せる説明 (Markdown)。 */
export function formatFailure(outcome) {
  return [
    '## Issue の紐づけゲート: この PR が閉じる Issue がありません',
    '',
    `${outcome.detail}。`,
    '',
    '### 直し方',
    '',
    '- PR 本文の「Test plan」に、閉じる Issue ごとに `### Closes #N` の小見出しを立てる',
    '- コードスパン (バッククォート)・引用 (`>`)・打ち消し (`~~`) の中の `Closes #N` は GitHub が紐づけない。',
    '  素の本文として書く',
    '- 段階に分けた作業は、段階ごとに sub-issue を切ってそれを閉じる (親 Issue を `Refs` で開いたままにしない)',
    `- 受け入れ条件を持たない PR (依存の手動更新・リリース準備など) は、ラベル \`${NO_ISSUE_LABEL}\` を付ける`,
    '',
    '本文の編集・ラベルの付け外しでこのチェックは再実行される。',
    '判定は本文の文字列ではなく、GitHub が作った紐づけ (closingIssuesReferences) を見る。根拠は ADR-0038',
  ].join('\n');
}

/** `--closing <path>` の JSON を読み、closingIssuesReferences の配列を返す。 */
export function readClosing(argv) {
  const index = argv.indexOf('--closing');
  const source = index === -1 ? undefined : argv[index + 1];
  if (source === undefined) throw new Error('--closing に gh pr view --json closingIssuesReferences の出力パスを渡す');
  const parsed = JSON.parse(readFileSync(source, 'utf8'));
  const refs = parsed?.closingIssuesReferences;
  if (!Array.isArray(refs)) throw new Error('closingIssuesReferences が配列ではない');
  return refs;
}

function main() {
  let outcome;
  try {
    const repo = process.env.GITHUB_REPOSITORY;
    if (!repo) throw new Error('GITHUB_REPOSITORY (owner/repo) が未設定');
    const argv = process.argv.slice(2);
    const { labels, author } = readPr(argv);
    outcome = evaluate({ closing: readClosing(argv), labels, author, repo });
  } catch (error) {
    console.error(`require-issue: 入力エラー: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
    return;
  }

  if (outcome.ok) {
    console.log(`require-issue: OK (${outcome.detail})`);
    return;
  }

  const message = formatFailure(outcome);
  console.log(message);
  console.log(`::error title=この PR が閉じる Issue がありません::${escapeAnnotation(message)}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
