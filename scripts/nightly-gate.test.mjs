import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkNightly, evaluateNightlyRuns, RECOVERY } from './nightly-gate.mjs';

const run = (conclusion, overrides = {}) => ({
  head_branch: 'main',
  status: 'completed',
  conclusion,
  run_number: 42,
  html_url: 'https://github.com/shinyaoguri/typedcode/actions/runs/42',
  ...overrides,
});
const success = run('success');
const failure = run('failure');

describe('latest completed main nightly', () => {
  it('accepts the latest success even when an older run failed', () => {
    assert.deepEqual(evaluateNightlyRuns([success, failure]), { ok: true, run: success });
  });
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped', 'neutral', 'action_required', null]) {
    it(`rejects latest ${conclusion}, even when an older run succeeded`, () => {
      assert.equal(evaluateNightlyRuns([run(conclusion), success]).ok, false);
    });
  }
  it('skips in-progress and queued runs and sees the latest completed failure', () => {
    assert.deepEqual(
      evaluateNightlyRuns([run(null, { status: 'in_progress' }), run(null, { status: 'queued' }), failure, success]),
      { ok: false, run: failure }
    );
    assert.equal(evaluateNightlyRuns([run(null, { status: 'in_progress' }), success]).ok, true);
  });
  it('rejects missing completed runs and does not use a different branch', () => {
    for (const runs of [[], [run(null, { status: 'queued' })], [run('success', { head_branch: 'feature' })]]) {
      assert.deepEqual(evaluateNightlyRuns(runs), { ok: false, run: null });
    }
    assert.throws(() => evaluateNightlyRuns(undefined), /Invalid workflow_runs/);
  });
});

describe('GitHub query', () => {
  it('queries completed main runs of the exact workflow, with bounded execution', () => {
    const result = checkNightly('shinyaoguri/typedcode', (command, args, options) => {
      assert.equal(command, 'gh');
      assert.deepEqual(args, [
        'api',
        'repos/shinyaoguri/typedcode/actions/workflows/e2e-nightly.yml/runs?branch=main&status=completed&per_page=1',
      ]);
      assert.equal(options.timeout, 30_000);
      return JSON.stringify({ workflow_runs: [success] });
    });
    assert.equal(result.html_url, success.html_url);
  });
  it('fails closed on API error or malformed response, without making another query', () => {
    for (const gh of [
      () => {
        throw new Error('API denied');
      },
      () => 'not-json',
      () => '{}',
    ]) {
      assert.throws(() => checkNightly('shinyaoguri/typedcode', gh));
    }
  });
  it('rejects invalid repository input and gives recovery instructions for red/missing runs', () => {
    assert.throws(() => checkNightly(''), /GITHUB_REPOSITORY/);
    for (const runs of [[failure], []]) {
      assert.throws(
        () => checkNightly('shinyaoguri/typedcode', () => JSON.stringify({ workflow_runs: runs })),
        (error) => error.message.includes(RECOVERY)
      );
    }
  });
});

it('CLI returns 0 only for success and always includes recovery instructions on failure', (t) => {
  const bin = mkdtempSync(join(tmpdir(), 'nightly-gate-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  // 変更操作は行わず、子プロセスの gh は固定の fixture を返すだけ。
  writeFileSync(
    join(bin, 'gh'),
    '#!/usr/bin/env node\nprocess.stdout.write(process.env.NIGHTLY_FIXTURE); process.exitCode = Number(process.env.NIGHTLY_API_EXIT);\n',
    { mode: 0o755 }
  );
  for (const [runs, apiExit, expected] of [
    [[success], 0, 0],
    [[failure, success], 0, 1],
    [[], 0, 1],
    [[success], 1, 1],
  ]) {
    const result = spawnSync(process.execPath, ['scripts/nightly-gate.mjs'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        GITHUB_REPOSITORY: 'shinyaoguri/typedcode',
        NIGHTLY_FIXTURE: JSON.stringify({ workflow_runs: runs }),
        NIGHTLY_API_EXIT: String(apiExit),
      },
    });
    assert.equal(result.status, expected, result.stderr);
    if (expected) assert.ok(result.stderr.includes(RECOVERY));
  }
});
