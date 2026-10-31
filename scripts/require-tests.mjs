#!/usr/bin/env node
/**
 * テスト必須ゲート (ADR-0034) — 実装を変えた PR がテストも変えているかを判定する。
 *
 * 「機能追加のたびに手動で動作確認する」のを「CI 緑なら手動確認不要」に置き換えるには、
 * 実装の変更にテストが伴うことを文書ルールではなく CI で強制する必要がある。判定は粗く
 * (どのテストが何を検査するかまでは見ない)、「実装だけ変えてテストに一切触れていない」PR を
 * 止める網として働く。テストが本当に不要な PR には逃げ道 (ラベル + 理由) を用意する。
 *
 * ルール:
 *   - 対象外 (pass): タイトルが docs / ci / chore 型、`(deps` / `(deps-dev)` を含む、
 *     author が dependabot[bot]
 *   - 実装の変更: packages/<pkg>/src/** のテストでない .ts/.mts/.mjs/.js/.html/.css と、
 *     packages/<pkg>/*.html (Vite のページエントリ。index.html / author.html)
 *   - テストの変更: __tests__/ 配下、*.test.ts、packages/e2e/tests/**、scripts/**\/*.test.*
 *   - 実装の変更があってテストの変更が無ければ fail。ただしラベル `no-test-needed` があり、
 *     本文の `## テスト不要の理由` 節に (HTML コメントを除いて) 空でない文があれば pass
 *
 * 使い方 (CI は .github/workflows/pr-checks.yml):
 *   git diff --name-only origin/main...HEAD | PR_TITLE='feat: ...' node scripts/require-tests.mjs
 *   node scripts/require-tests.mjs --files changed-files.txt
 *
 * 入力 (環境変数。PR 由来の文字列はシェルに展開せず env で受け取る):
 *   PR_TITLE / PR_BODY / PR_AUTHOR — そのまま
 *   PR_LABELS                       — ラベル名の JSON 配列 (例: '["no-test-needed"]')
 *   変更ファイル一覧                 — 1 行 1 パス。`--files <path>` (`-` または省略で stdin)
 *
 * exit 0 = pass / 1 = テスト不足 / 2 = 入力エラー
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 逃げ道のラベル名。CONTRIBUTING.md / PR テンプレートと揃える。 */
export const NO_TEST_LABEL = 'no-test-needed';
/** 逃げ道の理由を書く見出し (PR 本文)。CONTRIBUTING.md / PR テンプレートと揃える。 */
export const REASON_HEADING = 'テスト不要の理由';

const EXEMPT_TITLE_TYPES = ['docs', 'ci', 'chore'];
const EXEMPT_AUTHORS = ['dependabot[bot]'];
const IMPL_EXTENSIONS = /\.(ts|mts|mjs|js|html|css)$/;

/** 変更ファイルがテストの変更か。 */
export function isTestFile(file) {
  return (
    /(^|\/)__tests__\//.test(file) ||
    /\.test\.ts$/.test(file) ||
    file.startsWith('packages/e2e/tests/') ||
    /^scripts\/(.+\/)?[^/]+\.test\.[^/]+$/.test(file)
  );
}

/** 変更ファイルが実装の変更か (テストは実装に数えない)。 */
export function isImplementationFile(file) {
  if (isTestFile(file)) return false;
  if (/^packages\/[^/]+\/[^/]+\.html$/.test(file)) return true;
  return /^packages\/[^/]+\/src\//.test(file) && IMPL_EXTENSIONS.test(file);
}

/** ゲートの対象外にする PR なら、その理由を返す。対象なら null。 */
export function exemptionReason({ title = '', author = '' }) {
  if (EXEMPT_AUTHORS.includes(author)) return `author が ${author}`;
  const type = /^([a-z]+)(\([^()]*\))?!?:/.exec(title)?.[1];
  if (type && EXEMPT_TITLE_TYPES.includes(type)) return `タイトルの型が ${type}`;
  if (title.includes('(deps')) return 'タイトルが依存更新 (deps)';
  return null;
}

/**
 * PR 本文の `## テスト不要の理由` 節の中身 (HTML コメントを除いて trim 済み) を返す。
 * 見出しが無ければ null。節は次の `#` / `##` 見出しまで。
 */
export function extractNoTestReason(body = '') {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${REASON_HEADING}\\s*$`).test(line.trim()));
  if (start === -1) return null;
  const section = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    section.push(line);
  }
  return section
    .join('\n')
    .replace(/<!--[\s\S]*?(-->|$)/g, '')
    .trim();
}

/**
 * ゲートの判定 (純関数)。
 *
 * @param {{ files: string[], title?: string, labels?: string[], body?: string, author?: string }} pr
 * @returns {{ ok: boolean, verdict: 'exempt' | 'no-implementation' | 'has-tests' | 'waived' | 'missing-tests',
 *             detail: string, implementationFiles: string[], testFiles: string[] }}
 */
export function evaluate({ files, title = '', labels = [], body = '', author = '' }) {
  const implementationFiles = files.filter(isImplementationFile);
  const testFiles = files.filter(isTestFile);
  const result = (ok, verdict, detail) => ({ ok, verdict, detail, implementationFiles, testFiles });

  const exempt = exemptionReason({ title, author });
  if (exempt) return result(true, 'exempt', `対象外: ${exempt}`);
  if (implementationFiles.length === 0) return result(true, 'no-implementation', '実装の変更なし');
  if (testFiles.length > 0) return result(true, 'has-tests', `テストの変更 ${testFiles.length} 件あり`);

  const hasLabel = labels.includes(NO_TEST_LABEL);
  const reason = extractNoTestReason(body);
  if (hasLabel && reason) return result(true, 'waived', `ラベル ${NO_TEST_LABEL} と「${REASON_HEADING}」あり`);

  let detail;
  if (hasLabel && reason === null) {
    detail = `ラベル ${NO_TEST_LABEL} はあるが、PR 本文に「## ${REASON_HEADING}」見出しが無い`;
  } else if (hasLabel) {
    detail = `ラベル ${NO_TEST_LABEL} はあるが、「## ${REASON_HEADING}」の中身が空 (HTML コメントのみ)`;
  } else {
    detail = '実装を変更しているがテストの変更が無い';
  }
  return result(false, 'missing-tests', detail);
}

/** fail 時に人間へ見せる説明 (Markdown)。 */
export function formatFailure(outcome) {
  const list = outcome.implementationFiles.map((f) => `- \`${f}\``).join('\n');
  return [
    '## テスト必須ゲート: テストの変更がありません',
    '',
    `${outcome.detail}。`,
    '',
    '実装の変更 (テストを伴っていない):',
    '',
    list,
    '',
    '### 直し方',
    '',
    '- 振る舞いを変えた / 足したなら、それを表すテストを同じ PR に足す',
    '  (ロジックは `__tests__/` か `*.test.ts`、UI の振る舞いは `packages/e2e/tests/` の E2E)。',
    '  完了の定義は CONTRIBUTING.md「完了の定義 (Definition of Done)」',
    `- テストが本当に不要な変更 (挙動を変えないリファクタ・文言だけの修正など) なら、PR にラベル \`${NO_TEST_LABEL}\` を付け、`,
    `  PR 本文の \`## ${REASON_HEADING}\` 見出しの下に理由を書く (HTML コメントは数えない)。ラベル・本文の編集でこのチェックは再実行される`,
    '',
    'テストとして数えるもの: `__tests__/` 配下、`*.test.ts`、`packages/e2e/tests/**`、`scripts/**/*.test.*`',
  ].join('\n');
}

/** GitHub Actions の `::error::` 1 行に埋め込めるようにエスケープする。 */
function escapeAnnotation(text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function parseLabels(raw) {
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('PR_LABELS は JSON 配列で渡す');
  return parsed.map(String);
}

function readFiles(argv) {
  const index = argv.indexOf('--files');
  const source = index === -1 ? '-' : argv[index + 1];
  if (source === undefined) throw new Error('--files にはパス (または - で stdin) を渡す');
  const text = readFileSync(source === '-' ? 0 : source, 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function main() {
  let outcome;
  try {
    outcome = evaluate({
      files: readFiles(process.argv.slice(2)),
      title: process.env.PR_TITLE ?? '',
      body: process.env.PR_BODY ?? '',
      author: process.env.PR_AUTHOR ?? '',
      labels: parseLabels(process.env.PR_LABELS),
    });
  } catch (error) {
    console.error(`require-tests: 入力エラー: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
    return;
  }

  if (outcome.ok) {
    console.log(`require-tests: OK (${outcome.detail})`);
    return;
  }

  const message = formatFailure(outcome);
  console.log(message);
  console.log(`::error title=テストの変更がありません::${escapeAnnotation(message)}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
