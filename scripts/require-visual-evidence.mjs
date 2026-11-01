#!/usr/bin/env node
/**
 * 見た目の証跡ゲート (ADR-0036, #392) — 見た目に効くパスを変えた PR の本文に画像があるかを判定する。
 *
 * UI を変えた PR の本文に before/after の画像を載せる規律は、「気付いた人が貼る」運用だと抜ける
 * (直近の UI PR 9 件で画像 0 枚)。squash merge の後には証跡を足せないので、merge 前に欠落を
 * 機械で止める。require-tests (ADR-0034) と同じ形のゲートで、画像の中身の正しさは見ない
 * (人の目の仕事)。見た目が変わらない PR には逃げ道 (ラベル) を用意する。
 *
 * 判定は **PR 本文だけ** を見る。squash merge 後に残るのは本文で、PR へのコメント (bot が貼った
 * スクリーンショットを含む) は数えない。
 *
 * ルール:
 *   - 対象外 (pass): require-tests と同じ (タイトルが docs / ci / chore 型、`(deps` を含む、
 *     author が dependabot[bot])
 *   - 見た目のファイル (isVisualFile): packages/(editor|verify)/*.html、
 *     packages/(editor|verify)/src/**\/*.css、packages/editor/src/ui/(components|dialogs)/**、
 *     packages/verify/src/ui/*.ts (直下のみ。AppController.ts / fileInput.ts を除く)、
 *     packages/verify/src/charts/**。テスト (require-tests の isTestFile) は数えない
 *   - 見た目のファイルが無ければ pass。ラベル `no-visual-change` があれば pass
 *   - 本文 (HTML コメント・フェンス付きコードブロック・インラインコードを除く) に
 *     `![alt](url)` か `<img ... src=...>` があれば pass。無ければ fail
 *
 * 対象パスの選び方: 過去の PR を「絵がたいてい変わるか」で仕分けて決めた (gyazo-capture スキル D-b:
 * 対象パスは実績で決め、外れはラベルで逃がす)。
 *   - 発火して妥当: #386 #363 #318 (verify の ResultPanel など ui 直下 / editor の index.html・ui/components)
 *   - 発火するが見た目は変わらない (誤検知。ラベルで通す): #384 (ui/components の記録ロジック)、
 *     #348 (data-* の状態契約を DOM に足しただけ)
 *   - 発火しない: #367 (editor ui/tabs の復元順)、#373 (services の fetch)、
 *     #277 (verify ui/controllers の言語正規化)
 *   - 取りこぼし (承知のうえ): #369 は壊れた proof を error タブとして出す見た目の変化があったが、
 *     変更が ui/controllers・i18n・services に留まるので発火しない。ui/tabs・ui/controllers・
 *     翻訳 (src/i18n/**) は見た目に効かない変更 (状態管理・文言修正) が大半で、対象に含めると
 *     誤検知がラベル頼みになりゲートの信号が薄まるため外している
 *
 * 使い方 (CI は .github/workflows/pr-checks.yml):
 *   git diff --name-only origin/main...HEAD | PR_TITLE='feat: ...' PR_BODY="$(cat body.md)" node scripts/require-visual-evidence.mjs
 *   node scripts/require-visual-evidence.mjs --files changed-files.txt
 *
 * 入力 (環境変数。PR 由来の文字列はシェルに展開せず env で受け取る):
 *   PR_TITLE / PR_BODY / PR_AUTHOR — そのまま
 *   PR_LABELS                       — ラベル名の JSON 配列 (例: '["no-visual-change"]')
 *   変更ファイル一覧                 — 1 行 1 パス。`--files <path>` (`-` または省略で stdin)
 *
 * exit 0 = pass / 1 = 画像なし / 2 = 入力エラー
 */

import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { escapeAnnotation, exemptionReason, isTestFile, parseLabels, readFiles } from './require-tests.mjs';

/** 逃げ道のラベル名。CONTRIBUTING.md / PR テンプレートと揃える。 */
export const NO_VISUAL_LABEL = 'no-visual-change';
/** 画像を載せる PR 本文の節 (案内のみ。判定は本文のどこにあってもよい)。PR テンプレートと揃える。 */
export const EVIDENCE_HEADING = '見た目の証跡';

const VISUAL_PATTERNS = [
  // Vite のページエントリ (index.html / author.html)
  /^packages\/(editor|verify)\/[^/]+\.html$/,
  /^packages\/(editor|verify)\/src\/.+\.css$/,
  /^packages\/editor\/src\/ui\/(components|dialogs)\//,
  // verify の UI 部品は ui 直下に平置き (controllers/ は状態管理なので含めない)
  /^packages\/verify\/src\/ui\/[^/]+\.ts$/,
  /^packages\/verify\/src\/charts\//,
];
/** ui 直下でも DOM を描かない配線 (起動・状態の束ね / ファイル選択)。 */
const NON_VISUAL_FILES = ['packages/verify/src/ui/AppController.ts', 'packages/verify/src/ui/fileInput.ts'];

/** 変更ファイルが見た目に効くパスか (テストは数えない)。 */
export function isVisualFile(file) {
  if (isTestFile(file) || NON_VISUAL_FILES.includes(file)) return false;
  return VISUAL_PATTERNS.some((pattern) => pattern.test(file));
}

/**
 * フェンス付きコードブロック (``` / ~~~。閉じるフェンスは同じ文字で開きと同じ長さ以上) を取り除く。
 * 閉じていないフェンスは本文の終わりまで続く (GitHub の描画と同じ)。
 */
function stripFencedCode(text) {
  const kept = [];
  let fence = null;
  for (const line of text.split('\n')) {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open) {
      fence = open[1];
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * PR 本文に画像があるか。HTML コメント・フェンス付きコードブロック・インラインコードの中は数えない
 * (PR テンプレートの説明コメントや、書き方の例として置いた記法で通さないため)。
 */
export function hasImage(body = '') {
  const withoutComments = body.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?(-->|$)/g, '');
  const visible = stripFencedCode(withoutComments).replace(/(`+)[\s\S]*?\1/g, '');
  return (
    /!\[[^\]]*\]\(\s*<?[^\s)>]+/.test(visible) || /<img\b[^>]*\bsrc\s*=\s*("[^"]+"|'[^']+'|[^\s"'>]+)/i.test(visible)
  );
}

/**
 * ゲートの判定 (純関数)。
 *
 * @param {{ files: string[], title?: string, labels?: string[], body?: string, author?: string }} pr
 * @returns {{ ok: boolean, verdict: 'exempt' | 'no-visual-files' | 'waived' | 'has-image' | 'missing-image',
 *             detail: string, visualFiles: string[] }}
 */
export function evaluate({ files, title = '', labels = [], body = '', author = '' }) {
  const visualFiles = files.filter(isVisualFile);
  const result = (ok, verdict, detail) => ({ ok, verdict, detail, visualFiles });

  const exempt = exemptionReason({ title, author });
  if (exempt) return result(true, 'exempt', `対象外: ${exempt}`);
  if (visualFiles.length === 0) return result(true, 'no-visual-files', '見た目に効くパスの変更なし');
  if (labels.includes(NO_VISUAL_LABEL)) return result(true, 'waived', `ラベル ${NO_VISUAL_LABEL} あり`);
  if (hasImage(body)) return result(true, 'has-image', 'PR 本文に画像あり');
  return result(false, 'missing-image', '見た目に効くパスを変更しているが、PR 本文に画像が無い');
}

/** fail 時に人間へ見せる説明 (Markdown)。 */
export function formatFailure(outcome) {
  const list = outcome.visualFiles.map((f) => `- \`${f}\``).join('\n');
  return [
    '## 見た目の証跡ゲート: PR 本文に画像がありません',
    '',
    `${outcome.detail}。`,
    '',
    '見た目に効くパスに当たった変更:',
    '',
    list,
    '',
    '### 直し方',
    '',
    `- 見た目が変わるなら、PR 本文の「${EVIDENCE_HEADING}」節に before / after の画像を載せる`,
    '  (`![alt](url)` か `<img src="...">`)。素材は `npm run shots -w @typedcode/e2e` で撮れる。',
    '  アップロードの手順は repo-standards プラグインの gyazo-capture スキル',
    `- 見た目が変わらない変更 (ロジック・data-* の追加など) なら、PR にラベル \`${NO_VISUAL_LABEL}\` を付ける。`,
    '  ラベル・本文の編集でこのチェックは再実行される',
    '',
    '判定は PR 本文だけを見る (コメントの画像は数えない。squash merge 後に残るのは本文)。',
    'HTML コメント・コードブロック・インラインコードの中の画像も数えない。根拠は ADR-0036',
  ].join('\n');
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
    console.error(`require-visual-evidence: 入力エラー: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
    return;
  }

  if (outcome.ok) {
    console.log(`require-visual-evidence: OK (${outcome.detail})`);
    return;
  }

  const message = formatFailure(outcome);
  console.log(message);
  console.log(`::error title=PR 本文に画像がありません::${escapeAnnotation(message)}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
