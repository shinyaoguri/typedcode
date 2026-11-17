/**
 * PR ゲートの model-based E2E (tests/model/model-based.spec.ts の `model-pr-*`) の時間の上限 (#771)。
 *
 * 1 本が本当に失敗すると、1 回目は fast-check の縮約 (持ち時間 `shrinkLimitMs`) まで走り、Playwright の
 * retry (CI の `retries`) がもう 1 回流す。この 2 回の合計が e2e-shard job の `timeout-minutes` を超えると、
 * job ごと打ち切られて失敗の報告 (シード・反例・再実行コマンド) より先に cancel が出る。
 * そこで retry では縮約しない (固定シードなので、縮約しても同じ反例をもう一度探すだけ。runner.ts の `shrink`)。
 *
 * 上限はここの定数が正本で、spec はここから読む。合計が job の枠に収まるかは model-time-budget.test.mjs が
 * deploy.yml の `timeout-minutes` と playwright.config.ts の CI の `retries` を読んで検査する
 * (CI の check job が `packages/e2e/scripts/*.test.mjs` を回す)。
 */

/**
 * PR ゲートの model-based 1 本あたりの上限 (ミリ秒)。
 * - `shrinkLimitMs`: 1 回目の fast-check の持ち時間 (fc.interruptAfterTimeLimit)。超えたらそこまでの最小の反例で報告する。
 *   この打ち切りは列と列の間でしか効かないので、走っている 1 列 (`maxRunMs`) の分だけ超えうる
 * - `firstAttemptMs`: 1 回目の test timeout。報告が書かれる前に切られないよう `shrinkLimitMs + maxRunMs` 以上
 * - `retryAttemptMs`: retry の test timeout。縮約せず同じ列を 1 回流すだけなので `maxRunMs` 以上
 * - `maxRunMs`: 1 列 (15 手 + export + verify-cli) の上限の見込み。CI の実測 2.0〜2.1 分 (下の SHARD_MEASUREMENT) に余裕を足した値
 */
export const PR_MODEL_TIME_BUDGET = Object.freeze({
  shrinkLimitMs: 5 * 60_000,
  firstAttemptMs: 8 * 60_000,
  retryAttemptMs: 4 * 60_000,
  maxRunMs: 3 * 60_000,
});

/**
 * 計算の前提にする実測 (分)。model-pr-1 / 2 が入る shard の job 全体の所要時間と、通っているときの 1 本の所要時間。
 * 出典: main の Deploy の run 44037194832 / 44054037666 (3 shard。model-pr-1 / 2 は shard 2):
 * shard 2 の job は 16.4 分 / 17.0 分、model-pr-1 / 2 は各 2.0〜2.1 分。
 * spec が増えて shard が伸びたら、ここを実測に合わせて上げる (上げて検査が赤になれば、上の上限か shard の分割を見直す)。
 */
export const SHARD_MEASUREMENT = Object.freeze({
  shardMinutes: 17,
  passingRunMinutes: 2,
});

/**
 * 1 本の model-based が失敗したときの shard の所要時間の上限 (分)。
 * 失敗した 1 本は通ったときの 1 本 (`passingRunMinutes`) の代わりに、1 回目 + retries 回の retry を使う。
 * もう 1 つの worker が並行して残りを流すので実際はもっと短いが、上限として全部を足す。
 * @param {{ shardMinutes: number, passingRunMinutes: number }} measurement
 * @param {{ firstAttemptMs: number, retryAttemptMs: number }} budget
 * @param {number} retries
 */
export function worstFailingShardMinutes(measurement, budget, retries) {
  const failingMinutes = (budget.firstAttemptMs + retries * budget.retryAttemptMs) / 60_000;
  return measurement.shardMinutes - measurement.passingRunMinutes + failingMinutes;
}

/**
 * 上限どうしの整合と job の枠を照合し、破れている条件を文で返す (空なら整合)。
 * @param {{ shrinkLimitMs: number, firstAttemptMs: number, retryAttemptMs: number, maxRunMs: number }} budget
 * @param {{ shardMinutes: number, passingRunMinutes: number }} measurement
 * @param {{ retries: number, timeoutMinutes: number }} ci
 * @returns {string[]}
 */
export function budgetViolations(budget, measurement, ci) {
  const violations = [];
  if (budget.shrinkLimitMs + budget.maxRunMs > budget.firstAttemptMs) {
    violations.push(
      `shrinkLimitMs (${budget.shrinkLimitMs}) + maxRunMs (${budget.maxRunMs}) exceeds firstAttemptMs (${budget.firstAttemptMs}): the test timeout would cut the first attempt before the failure report is written`
    );
  }
  if (budget.maxRunMs > budget.retryAttemptMs) {
    violations.push(
      `maxRunMs (${budget.maxRunMs}) exceeds retryAttemptMs (${budget.retryAttemptMs}): the retry cannot finish one run`
    );
  }
  const worst = worstFailingShardMinutes(measurement, budget, ci.retries);
  if (worst > ci.timeoutMinutes) {
    violations.push(
      `a failing model-based test can take the shard to ${worst} min, over the e2e-shard timeout-minutes (${ci.timeoutMinutes})`
    );
  }
  return violations;
}

/**
 * deploy.yml の e2e-shard job の `timeout-minutes` を読む (job の直下の 1 つだけ。YAML の依存を足さないため、
 * job の範囲 = 次のトップレベルの job までを行で切り出す)。見つからなければ throw する。
 * @param {string} workflowText
 * @returns {number}
 */
export function e2eShardTimeoutMinutes(workflowText) {
  const lines = workflowText.split('\n');
  const start = lines.findIndex((l) => /^ {2}e2e-shard:\s*$/.test(l));
  if (start < 0) throw new Error('job e2e-shard not found in the workflow');
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}[\w-]+:\s*$/.test(line)) break;
    const m = /^ {4}timeout-minutes:\s*(\d+)\s*$/.exec(line);
    if (m) return Number(m[1]);
  }
  throw new Error('timeout-minutes not found directly under job e2e-shard');
}

/**
 * playwright.config.ts の CI のときの `retries` (`retries: isCI ? N : 0`) を読む。形が変わったら throw する。
 * @param {string} configText
 * @returns {number}
 */
export function ciRetries(configText) {
  const matches = [...configText.matchAll(/^\s*retries:\s*isCI\s*\?\s*(\d+)\s*:\s*\d+\s*,/gm)];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one "retries: isCI ? N : M," in playwright.config.ts (found ${matches.length})`);
  }
  return Number(matches[0][1]);
}
