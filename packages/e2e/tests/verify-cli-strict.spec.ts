import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { EditorApp, readProofJson } from './helpers/app.js';
import type { ProofCheckpoint } from './helpers/app.js';
import { injectApiFault } from './helpers/faults.js';
import { runVerifyCliWithResult } from './helpers/verifyCli.js';
import type { CliResultEntry, CliResultWithResult } from './helpers/verifyCli.js';

/**
 * verify-cli の採点向けの strict フラグ (#590): `--require-root-anchor` (ADR-0017) と
 * `--require-anchor-density` (ADR-0016) が、editor で作った実 proof に対してゲートとして効く。
 *
 * 判定は shared の受理ポリシー (`evaluateAcceptancePolicy`, ADR-0043) が持ち、ユニット
 * (shared の acceptancePolicy.test / verify-cli の cliAcceptancePolicy.test) は組み立てた proof で固定している。
 * ここでは「本物の editor の proof で、フラグを立てたときだけ exit 1 になり、その理由が受理ポリシーの
 * 違反である」ことを round-trip で確かめる。理由は stdout の文言ではなく `--result-json` の
 * `failedCheck` (`policy`) と `policyViolations` で読む。
 *
 * 密度ゲートは署名 cp が 0 件の proof を対象外にする (`density: null`。cp の存在を求めるのは
 * `--require-signed-checkpoints`)。そのため密度ゲートが効くことは「署名 cp はあるが、最後の署名から
 * 500 イベントを超えて未署名」の proof (途中で `/api/checkpoint/sign` を落として作る) で確かめる。
 *
 * verify-cli はすべて `--mode fast` (不変条件 4)。PoSW の再計算は受理ポリシーの判定に関係しない。
 */

/** checkpoint は 100 イベントごとか 10 秒ごとにできる (CheckpointManager)。それを確実に超える打鍵。 */
const CHECKPOINT_TRIGGER_CODE = 'int total = 0;\nfor (int i = 0; i < 10; i++) {\ntotal += i;\n}\n';

/**
 * 密度ゲートの閾値 (shared の `MAX_ANCHOR_GAP_EVENTS` = 500) を確実に超える、署名の止まった後の
 * イベント数。export の前後に積まれるイベントの揺れを見込んで余裕を取る。
 */
const UNSIGNED_TAIL_TARGET_EVENTS = 650;

/** 1 回に打つ分 (打鍵 1 文字で複数のイベントが積まれる)。 */
const FILLER_CHUNK = 'total = total + 1;\n'.repeat(4);

interface ProofForPolicy {
  rootAnchored?: boolean;
  checkpoints?: ProofCheckpoint[];
  proof?: { events?: unknown[] };
}

function signedCheckpoints(proof: ProofForPolicy): ProofCheckpoint[] {
  return (proof.checkpoints ?? []).filter((cp) => cp.signature);
}

/** 最後の署名 cp より後のイベント数 (密度ゲートの末尾ギャップと同じ数え方)。 */
function unsignedTailEvents(proof: ProofForPolicy): number {
  const total = proof.proof?.events?.length ?? 0;
  const lastSigned = Math.max(-1, ...signedCheckpoints(proof).map((cp) => cp.eventIndex ?? -1));
  return total - 1 - lastSigned;
}

/** `/api/checkpoint/sign` が署名を返す (2xx) のを待つ Promise。打鍵の前に作る。 */
function waitForSignedCheckpoint(page: Page): Promise<unknown> {
  return page.waitForResponse(
    (res) => res.url().endsWith('/api/checkpoint/sign') && res.request().method() === 'POST' && res.ok(),
    { timeout: 60_000 }
  );
}

function onlyResult(cli: CliResultWithResult): CliResultEntry {
  expect(cli.results, cli.stdout + cli.stderr).toHaveLength(1);
  return cli.results[0]!;
}

/** フラグを立てずに通る (positive control)。strict での失敗がフラグだけに由来することの前提。 */
function expectPassesWithoutFlags(zipPath: string): void {
  const cli = runVerifyCliWithResult(zipPath, ['--mode', 'fast']);
  expect(cli.exitCode, cli.stdout + cli.stderr).toBe(0);
  expect(onlyResult(cli)).toMatchObject({ valid: true, failedCheck: null, policyViolations: [] });
}

/** `flags` を立てると exit 1 で、落ちた層が受理ポリシーの `violations` だけ (整合性は通っている)。 */
function expectRejectedByPolicy(zipPath: string, flags: string[], violations: string[]): void {
  const cli = runVerifyCliWithResult(zipPath, ['--mode', 'fast', ...flags]);
  const ctx = `${flags.join(' ')}\n${cli.stdout}${cli.stderr}`;
  expect(cli.exitCode, ctx).toBe(1);
  expect(onlyResult(cli), ctx).toMatchObject({
    valid: false,
    integrityValid: true,
    failedCheck: 'policy',
    policyViolations: violations,
  });
}

/** `flags` を立てても exit 0 で、受理ポリシーの違反が無い。 */
function expectAcceptedWith(zipPath: string, flags: string[]): void {
  const cli = runVerifyCliWithResult(zipPath, ['--mode', 'fast', ...flags]);
  const ctx = `${flags.join(' ')}\n${cli.stdout}${cli.stderr}`;
  expect(cli.exitCode, ctx).toBe(0);
  expect(onlyResult(cli), ctx).toMatchObject({ valid: true, failedCheck: null, policyViolations: [] });
}

test('署名 cp の無い proof は --require-root-anchor で受理ポリシーの違反として exit 1 になり、密度ゲートは対象外にする', async ({
  page,
}) => {
  // session/start を落とすと root のトークンが無く、署名 (トークン前提 = ADR-0027) も走らない。
  const injected = await injectApiFault(page, 'session/start', 'abort');
  const app = new EditorApp(page);
  await app.openCasualFresh();
  expect(injected.calls(), 'the startup tab must hit the injected session/start').toBe(1);

  await app.typeCode(CHECKPOINT_TRIGGER_CODE);
  await app.waitForSynced();
  const zipPath = await app.exportCurrentTab();

  const proof = (await readProofJson(zipPath)) as ProofForPolicy;
  expect(proof.rootAnchored, 'precondition: root is not server-anchored').toBe(false);
  expect(signedCheckpoints(proof), 'precondition: no signed checkpoint').toEqual([]);

  expectPassesWithoutFlags(zipPath);
  expectRejectedByPolicy(zipPath, ['--require-root-anchor'], ['root-anchor-missing']);
  expectRejectedByPolicy(zipPath, ['--require-root-anchor', '--require-anchor-density'], ['root-anchor-missing']);
  // 署名 cp が 0 件の proof は密度ゲートの対象外 (ADR-0016)。cp の存在を求めるのは別のフラグ。
  expectAcceptedWith(zipPath, ['--require-anchor-density']);
});

test('root がアンカーされ署名 cp が密に付いた proof は --require-root-anchor と --require-anchor-density を立てても exit 0 になる', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();

  const signed = waitForSignedCheckpoint(page);
  await app.typeCode(CHECKPOINT_TRIGGER_CODE);
  await signed;
  await app.waitForSynced();
  const zipPath = await app.exportCurrentTab();

  const proof = (await readProofJson(zipPath)) as ProofForPolicy;
  expect(proof.rootAnchored, 'precondition: root is server-anchored').toBe(true);
  expect(signedCheckpoints(proof).length, 'precondition: signed checkpoints exist').toBeGreaterThan(0);

  expectAcceptedWith(zipPath, ['--require-root-anchor', '--require-anchor-density']);
});

test('署名が途中で止まり末尾 500 イベント超が未署名の proof は --require-anchor-density で exit 1 になり、--require-root-anchor では通る', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();

  // 1 個目の署名 cp を得てから署名を止め、密度の閾値を超えるイベントを積む。
  const signed = waitForSignedCheckpoint(page);
  await app.typeCode(CHECKPOINT_TRIGGER_CODE);
  await signed;
  const injected = await injectApiFault(page, 'checkpoint/sign', 'abort');
  await app.waitForSynced();
  const eventsAtFault = await app.eventCount();
  // `#event-count` は PoSW を済ませたイベントの数なので、打鍵のたびに掃けるのを待ってから数える
  // (待たずに数を見ながら打ち続けると、PoSW の処理待ちが積み上がって同期が終わらなくなる)。
  while ((await app.eventCount()) - eventsAtFault < UNSIGNED_TAIL_TARGET_EVENTS) {
    await app.typeCode(FILLER_CHUNK);
    await app.waitForSynced();
  }
  // 署名が止まった後も checkpoint ができて sign が呼ばれた (注入が空振りしていない)。
  await expect.poll(() => injected.calls(), { timeout: 30_000 }).toBeGreaterThan(0);
  const zipPath = await app.exportCurrentTab();

  const proof = (await readProofJson(zipPath)) as ProofForPolicy;
  expect(proof.rootAnchored, 'precondition: root is server-anchored').toBe(true);
  expect(signedCheckpoints(proof).length, 'precondition: a signed checkpoint exists').toBeGreaterThan(0);
  expect(unsignedTailEvents(proof), 'precondition: the unsigned tail exceeds the density threshold').toBeGreaterThan(
    500
  );

  // 密度不足は既定では warning のまま (exit 0)。
  expectPassesWithoutFlags(zipPath);
  expectRejectedByPolicy(zipPath, ['--require-anchor-density'], ['anchor-density-sparse']);
  expectAcceptedWith(zipPath, ['--require-root-anchor']);
});
