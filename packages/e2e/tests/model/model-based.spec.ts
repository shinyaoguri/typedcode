import { test } from '@playwright/test';
import { PR_MODEL_TIME_BUDGET } from '../../scripts/model-time-budget.mjs';
import { envInt, runModelBased } from './runner.js';

/**
 * model-based E2E (#436): ランダムな操作列 (タブの追加・切替・改名・閉じる・打鍵・外部ペースト・
 * 内部コピペ・言語変更・リロード・ブラウザのタブを閉じて復旧ダイアログから再開 (保存データに手を入れる変種を含む)・
 * フォーカス喪失・export) を実エディタに流し、各手の後にモデル (tests/model/editorModel.ts) と状態契約・内部状態・
 * 件数・エラーを突き合わせ、再開の後と最後には保存データ (IndexedDB) も突き合わせ、最後に全タブの export を
 * verify-cli (--mode fast) で検証し、`tab-switches.json` の並びをモデルの切替の履歴と突き合わせる。
 *
 * - PR ゲート: 固定シード 2 本 × 15 手 (各 1 列)。シードを変えるとゲートの中身が変わるので、変えるときは
 *   PR に理由を書く
 * - `@nightly`: ランダムシード (FC_SEED 指定時はそれ) で長い列を複数本。通常の実行と CI のシャードからは
 *   playwright.config.ts の grepInvert で外し、NIGHTLY=1 のときだけ走る (.github/workflows/e2e-nightly.yml)
 *
 * 失敗の再現は報告に出るコマンド (FC_SEED / FC_PATH / FC_REPLAY_PATH) で行う (runner.ts)。
 */

// 2 本の固定シードを別のワーカー・シャードに散らせるようにする (ファイル単位だと同じシャードに寄る)。
test.describe.configure({ mode: 'parallel' });

const PR_STEPS = 15;
// 2 本で全 15 種の手 (閉じるは確定とキャンセルを、閉じて再開は保存データに手を入れない / staleHash /
// emptyTabOrder を別に数える) を通り、それぞれ 14〜15 手が実際に走るシードを選んだ (#616)。どちらも
// 閉じて再開する手で観測する退行 (#616。editorModel.ts の CloseAndResume) を通る:
// - #401: 再開の前に、ページの読み込み (リロード・再開) をまたいだタブ切替が履歴に並ぶ (timestamp の順と
//   追記順が食い違う) 状態で再開し、その後の export で `tab-switches.json` の並びを見る
// - #322: CloseAndResume(staleHash) を 1 回以上通る / #367: 617230 が CloseAndResume(emptyTabOrder) をタブ 2 本以上で通る
// アプリを使わない仮のドライバで 616000〜618999 を縮約なしで流して選び、実アプリで同じ手が走ることを確かめた:
// 617230 = 再開 4 回 (staleHash・emptyTabOrder 各 1)・リロード・改名・外部ペースト、
// 617841 = 再開 2 回 (staleHash 1)・切替・内部コピペ・言語変更・export 2 回・閉じる確定 / キャンセル。
// 手を足すと fc.commands の生成列が変わるので、手を足す PR は同じ手順でシードを選び直す。
const PR_SEEDS = [617_230, 617_841] as const;

for (const [i, seed] of PR_SEEDS.entries()) {
  const grepToken = `model-pr-${i + 1}`;
  test(`${grepToken}: 固定シード ${seed} の操作列で、各手の後に実アプリがモデルと一致し、全 proof が検証を通る`, async ({
    browser,
  }, testInfo) => {
    // 失敗したとき、1 回目は縮約まで走り、Playwright の retry では縮約せず同じ列を流し直して報告する
    // (固定シードなので縮約しても同じ反例を探し直すだけ)。上限と、それが e2e-shard job の timeout-minutes に
    // 収まることの検査は scripts/model-time-budget.mjs / .test.mjs (#771)。
    const retry = testInfo.retry > 0;
    test.setTimeout(retry ? PR_MODEL_TIME_BUDGET.retryAttemptMs : PR_MODEL_TIME_BUDGET.firstAttemptMs);
    await runModelBased({
      browser,
      testInfo,
      grepToken,
      seed: envInt('FC_SEED') ?? seed,
      steps: envInt('FC_STEPS') ?? PR_STEPS,
      runs: envInt('FC_RUNS') ?? 1,
      timeLimitMs: PR_MODEL_TIME_BUDGET.shrinkLimitMs,
      shrink: !retry,
      nightly: false,
    });
  });
}

test('model-nightly: @nightly ランダムシードの長い操作列で、各手の後に実アプリがモデルと一致し、全 proof が検証を通る', async ({
  browser,
}, testInfo) => {
  test.setTimeout(75 * 60_000);
  await runModelBased({
    browser,
    testInfo,
    grepToken: 'model-nightly',
    seed: envInt('FC_SEED') ?? Date.now() ^ Math.floor(Math.random() * 0x7fffffff),
    steps: envInt('FC_STEPS') ?? 40,
    runs: envInt('FC_RUNS') ?? 3,
    timeLimitMs: 60 * 60_000,
    shrink: true,
    nightly: true,
  });
});
