#!/usr/bin/env node
/** #593: 本番の承認前に、main の最新の完了 nightly が成功していることを要求する。 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const RECOVERY =
  'gh workflow run e2e-nightly.yml --ref main で nightly を緑にしてから、失敗した nightly-gate job を re-run してください。';

export function evaluateNightlyRuns(runs) {
  if (!Array.isArray(runs)) throw new Error('Invalid workflow_runs response');
  // API は新しい run から返す。進行中を飛ばすが、完了した失敗を飛ばして古い成功を選ばない。
  const latest = runs.find((run) => run.head_branch === 'main' && run.status === 'completed');
  return { ok: latest?.conclusion === 'success', run: latest ?? null };
}

export function checkNightly(repository, gh = execFileSync) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('GITHUB_REPOSITORY is required');
  // status=completed をサーバ側で絞るため、走行中の run が何件あっても直近の完了を取得する。
  // conclusion=success では絞らない (最新の失敗を隠さない)。actions:read だけを必要とする。
  const output = gh(
    'gh',
    ['api', `repos/${repository}/actions/workflows/e2e-nightly.yml/runs?branch=main&status=completed&per_page=1`],
    {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  const verdict = evaluateNightlyRuns(JSON.parse(output).workflow_runs);
  if (!verdict.ok) {
    const detail = verdict.run
      ? `nightly #${verdict.run.run_number}: ${verdict.run.conclusion} (${verdict.run.html_url})`
      : 'main の完了した nightly run がありません';
    throw new Error(`${detail}\n${RECOVERY}`);
  }
  return verdict.run;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const run = checkNightly(process.env.GITHUB_REPOSITORY);
    console.log(`Nightly gate passed: ${run.html_url}`);
  } catch (error) {
    console.error(`Nightly gate failed: ${error.message}\n${RECOVERY}`);
    process.exitCode = 1;
  }
}
