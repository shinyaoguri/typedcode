/**
 * model-time-budget.mjs のテスト (#771)。PR ゲートの model-based E2E が本当に失敗しても、縮約と retry を
 * 合わせて e2e-shard job の `timeout-minutes` に収まることを、実物の deploy.yml と playwright.config.ts を
 * 読んで確かめる。
 *
 * 実行: `node --test packages/e2e/scripts/model-time-budget.test.mjs` (CI は deploy.yml の check job が回す)。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  budgetViolations,
  ciRetries,
  e2eShardTimeoutMinutes,
  PR_MODEL_TIME_BUDGET,
  SHARD_MEASUREMENT,
  worstFailingShardMinutes,
} from './model-time-budget.mjs';

const E2E_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(E2E_DIR, '..', '..');
const read = (path) => readFileSync(path, 'utf8');

test('a failing PR-gate model-based test, with its retry, keeps the shard within the e2e-shard timeout-minutes', () => {
  const ci = {
    retries: ciRetries(read(join(E2E_DIR, 'playwright.config.ts'))),
    timeoutMinutes: e2eShardTimeoutMinutes(read(join(REPO_ROOT, '.github/workflows/deploy.yml'))),
  };
  assert.deepEqual(budgetViolations(PR_MODEL_TIME_BUDGET, SHARD_MEASUREMENT, ci), []);
});

test('the PR-gate spec takes its time limits from this budget and does not shrink on a Playwright retry', () => {
  const spec = read(join(E2E_DIR, 'tests/model/model-based.spec.ts'));
  for (const field of ['shrinkLimitMs', 'firstAttemptMs', 'retryAttemptMs']) {
    assert.match(spec, new RegExp(`PR_MODEL_TIME_BUDGET\\.${field}\\b`), `model-based.spec.ts reads ${field}`);
  }
  // 上の計算は「retry は縮約せず 1 列だけ流す」前提 (retryAttemptMs が 1 列分しかない)
  assert.match(spec, /const retry = testInfo\.retry > 0;/);
  assert.match(spec, /shrink: !retry,/);
});

test('the worst case adds every attempt of the failing test in place of its passing run', () => {
  const minutes = worstFailingShardMinutes(
    { shardMinutes: 17, passingRunMinutes: 2 },
    { firstAttemptMs: 8 * 60_000, retryAttemptMs: 4 * 60_000 },
    1
  );
  assert.equal(minutes, 17 - 2 + 8 + 4);
});

test('budgetViolations names a first attempt too short to write the report, a retry shorter than one run, and an overrun of the job', () => {
  const ok = { shrinkLimitMs: 5, firstAttemptMs: 8, retryAttemptMs: 4, maxRunMs: 3 };
  const measurement = { shardMinutes: 17, passingRunMinutes: 2 };
  const ci = { retries: 1, timeoutMinutes: 30 };
  const toMs = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v * 60_000]));
  assert.deepEqual(budgetViolations(toMs(ok), measurement, ci), []);
  assert.match(budgetViolations(toMs({ ...ok, shrinkLimitMs: 6 }), measurement, ci).join('\n'), /firstAttemptMs/);
  assert.match(
    budgetViolations(toMs({ ...ok, maxRunMs: 4.5, firstAttemptMs: 10 }), measurement, ci).join('\n'),
    /retryAttemptMs/
  );
  assert.match(
    budgetViolations(toMs(ok), measurement, { ...ci, timeoutMinutes: 26 }).join('\n'),
    /timeout-minutes \(26\)/
  );
});

test('e2eShardTimeoutMinutes reads timeout-minutes of the e2e-shard job only', () => {
  const yml = [
    'jobs:',
    '  check:',
    '    timeout-minutes: 10',
    '  e2e-shard:',
    '    name: e2e',
    '    timeout-minutes: 30',
    '    steps:',
    '      - run: x',
    '        timeout-minutes: 5',
    '  e2e:',
    '    timeout-minutes: 5',
  ].join('\n');
  assert.equal(e2eShardTimeoutMinutes(yml), 30);
  assert.throws(() => e2eShardTimeoutMinutes(yml.replace('    timeout-minutes: 30\n', '')), /not found/);
  assert.throws(() => e2eShardTimeoutMinutes('jobs:\n  check:\n'), /e2e-shard not found/);
});

test('ciRetries reads the CI retries and refuses a config whose retries it cannot read', () => {
  assert.equal(ciRetries('  forbidOnly: isCI,\n  retries: isCI ? 2 : 0,\n'), 2);
  assert.throws(() => ciRetries('  retries: 1,\n'), /found 0/);
});
