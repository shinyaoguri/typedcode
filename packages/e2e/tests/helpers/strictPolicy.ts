import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { EditorApp, ProofCheckpoint } from './app.js';
import { runVerifyCliWithResult } from './verifyCli.js';
import type { CliResultEntry, CliResultWithResult } from './verifyCli.js';

/**
 * verify-cli の strict フラグ (受理ポリシー。ADR-0043) の spec が共有する手順 (#590)。
 * `verify-cli-strict.spec.ts` (root アンカーと密な proof) と `verify-cli-strict-sparse.spec.ts` (疎な proof) が使う。
 * 疎な proof を作る 1 本が遅い CI で数分かかるので、1 ファイルが Slow Test の閾値 5 分を超えないよう分けた
 * (#525 / #533 と同じ理由)。
 *
 * 結論は stdout の文言ではなく `--result-json` の `failedCheck` (`policy`) と `policyViolations` で読む。
 * verify-cli はすべて `--mode fast` (不変条件 4)。PoSW の再計算は受理ポリシーの判定に関係しない。
 */

/** checkpoint は 100 イベントごとか 10 秒ごとにできる (CheckpointManager)。それを確実に超える打鍵。 */
export const CHECKPOINT_TRIGGER_CODE = 'int total = 0;\nfor (int i = 0; i < 10; i++) {\ntotal += i;\n}\n';

/** proof のうち受理ポリシーの前提を確かめるのに読む部分。 */
export interface ProofForPolicy {
  rootAnchored?: boolean;
  checkpoints?: ProofCheckpoint[];
  proof?: { events?: unknown[] };
}

export function signedCheckpoints(proof: ProofForPolicy): ProofCheckpoint[] {
  return (proof.checkpoints ?? []).filter((cp) => cp.signature);
}

/** 最後の署名 cp より後のイベント数 (密度ゲートの末尾ギャップと同じ数え方)。 */
export function unsignedTailEvents(proof: ProofForPolicy): number {
  const total = proof.proof?.events?.length ?? 0;
  const lastSigned = Math.max(-1, ...signedCheckpoints(proof).map((cp) => cp.eventIndex ?? -1));
  return total - 1 - lastSigned;
}

/**
 * `/api/checkpoint/sign` が署名を返す (2xx) のを待つ Promise。打鍵の前に作る。
 * 打鍵の所要時間はランナーの速さで変わる (`typeAtRecordingPace` は PoSW の速さに合わせて打つ) ので、
 * 上限は付けずテストの timeout に任せる。
 */
export function waitForSignedCheckpoint(page: Page): Promise<unknown> {
  return page.waitForResponse(
    (res) => res.url().endsWith('/api/checkpoint/sign') && res.request().method() === 'POST' && res.ok(),
    { timeout: 0 }
  );
}

/**
 * `code` を 1 打鍵ずつ打ち、打鍵ごとに PoSW の処理待ちが掃けるのを待つ (記録が入力に追いつく速さで打つ)。
 * 正直な proof が密度ゲートで「密」になることを、ランナーの速さに依らず保証するための打ち方。
 *
 * 密度ゲートの判定の 1 つは、連続する署名 cp k, k+1 の間のイベント x について e_x − e_k ≤ 50 秒
 * (shared の `MAX_UNANCHORED_EVENT_SPAN_MS`。e は打鍵した時刻) を求める。checkpoint は PoSW を済ませたイベントに
 * 作られ、時間トリガ (最後の cp から 10 秒) も処理した時刻で引かれるので、cp の付かないイベント x は k の処理から
 * 10 秒以内に処理されている。よって e_x − e_k は「10 秒 + k の時点の処理待ち (打鍵から処理までの遅れ)」で抑えられる
 * (export で積まれるイベントも同じ)。まとめて打つとこの遅れが「打鍵量 × 1 イベントの PoSW 時間」まで伸び、遅い CI
 * ランナーでは正直な proof でも 50 秒を超えて「疎」になった (#590 の CI)。1 打鍵ごとに掃けるのを待てば、遅れは
 * 1 打鍵ぶん (数イベント) の処理時間で頭打ちになる。
 */
export async function typeAtRecordingPace(app: EditorApp, code: string): Promise<void> {
  await app.focusEditor();
  for (const ch of code) {
    await app.page.keyboard.type(ch);
    await app.waitForSynced();
  }
}

function onlyResult(cli: CliResultWithResult): CliResultEntry {
  expect(cli.results, cli.stdout + cli.stderr).toHaveLength(1);
  return cli.results[0]!;
}

/** フラグを立てずに通る (positive control)。strict での失敗がフラグだけに由来することの前提。 */
export function expectPassesWithoutFlags(zipPath: string): void {
  const cli = runVerifyCliWithResult(zipPath, ['--mode', 'fast']);
  expect(cli.exitCode, cli.stdout + cli.stderr).toBe(0);
  expect(onlyResult(cli)).toMatchObject({ valid: true, failedCheck: null, policyViolations: [] });
}

/** `flags` を立てると exit 1 で、落ちた層が受理ポリシーの `violations` だけ (整合性は通っている)。 */
export function expectRejectedByPolicy(zipPath: string, flags: string[], violations: string[]): void {
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
export function expectAcceptedWith(zipPath: string, flags: string[]): void {
  const cli = runVerifyCliWithResult(zipPath, ['--mode', 'fast', ...flags]);
  const ctx = `${flags.join(' ')}\n${cli.stdout}${cli.stderr}`;
  expect(cli.exitCode, ctx).toBe(0);
  expect(onlyResult(cli), ctx).toMatchObject({ valid: true, failedCheck: null, policyViolations: [] });
}
