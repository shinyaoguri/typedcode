import { test } from '@playwright/test';
import { envInt, runModelBased } from './runner.js';

/**
 * model-based E2E (#436): ランダムな操作列 (タブの追加・切替・改名・閉じる・打鍵・外部ペースト・
 * 内部コピペ・言語変更・リロード・ブラウザのタブを閉じて復旧ダイアログから再開・フォーカス喪失・export) を実エディタに流し、各手の後にモデル
 * (tests/model/editorModel.ts) と状態契約・内部状態・件数・エラーを突き合わせ、最後に全タブの export を
 * verify-cli (--mode fast) で検証する。
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
// 2 本で全 13 種の手 (閉じるは確定とキャンセルを別に数える) を通り、それぞれ 14〜15 手が実際に走る
// シードを選んだ (#450)。どちらも「タブを閉じて復旧ダイアログから再開する」手
// (CloseAndResume) をタブ 2 本・アクティブが 2 本目の状態で通る (IndexedDB 復旧の経路。#322 / #367 / #401)。
// 縮約の無い dry-run で確かめた: 450436 = 3 回の CloseAndResume・3 回のリロード・閉じる確定、
// 450582 = 外部ペースト 2 回・内部コピペ・言語変更・export。手を足すと fc.commands の生成列が変わるので、
// 手を足す PR は同じ手順でシードを選び直す。
const PR_SEEDS = [450_436, 450_582] as const;

for (const [i, seed] of PR_SEEDS.entries()) {
  const grepToken = `model-pr-${i + 1}`;
  test(`${grepToken}: 固定シード ${seed} の操作列で、各手の後に実アプリがモデルと一致し、全 proof が検証を通る`, async ({
    browser,
  }, testInfo) => {
    test.setTimeout(12 * 60_000);
    await runModelBased({
      browser,
      testInfo,
      grepToken,
      seed: envInt('FC_SEED') ?? seed,
      steps: envInt('FC_STEPS') ?? PR_STEPS,
      runs: envInt('FC_RUNS') ?? 1,
      // 1 列 (~数分) + 失敗時の縮約。超えたらそこまでの最小の反例で報告する (シャードの 30 分に収める)。
      timeLimitMs: 8 * 60_000,
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
    nightly: true,
  });
});
