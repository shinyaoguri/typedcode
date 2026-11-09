import { test, expect } from '@playwright/test';
import { EditorApp, readProofJson } from './helpers/app.js';
import { injectApiFault } from './helpers/faults.js';
import {
  CHECKPOINT_TRIGGER_CODE,
  expectAcceptedWith,
  expectPassesWithoutFlags,
  expectRejectedByPolicy,
  signedCheckpoints,
  typeAtRecordingPace,
  waitForSignedCheckpoint,
  type ProofForPolicy,
} from './helpers/strictPolicy.js';

/**
 * verify-cli の採点向けの strict フラグ (#590): `--require-root-anchor` (ADR-0017) と
 * `--require-anchor-density` (ADR-0016) が、editor で作った実 proof に対してゲートとして効く。
 *
 * 判定は shared の受理ポリシー (`evaluateAcceptancePolicy`, ADR-0043) が持ち、ユニット
 * (shared の acceptancePolicy.test / verify-cli の cliAcceptancePolicy.test) は組み立てた proof で固定している。
 * ここでは「本物の editor の proof で、フラグを立てたときだけ exit 1 になり、その理由が受理ポリシーの
 * 違反である」ことを round-trip で確かめる (共通の手順と結論の読み方は helpers/strictPolicy.ts)。
 *
 * 密度ゲートは署名 cp が 0 件の proof を対象外にする (`density: null`。cp の存在を求めるのは
 * `--require-signed-checkpoints`)。密度ゲートが疎な proof を拒否することは verify-cli-strict-sparse.spec.ts。
 */

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
  // 記録が入力に追いつく速さで打つ (まとめて打つと遅いランナーで正直な proof も「疎」になる。doc を参照)。
  await typeAtRecordingPace(app, CHECKPOINT_TRIGGER_CODE);
  await signed;
  await app.waitForSynced();
  const zipPath = await app.exportCurrentTab();

  const proof = (await readProofJson(zipPath)) as ProofForPolicy;
  expect(proof.rootAnchored, 'precondition: root is server-anchored').toBe(true);
  expect(signedCheckpoints(proof).length, 'precondition: signed checkpoints exist').toBeGreaterThan(0);

  expectAcceptedWith(zipPath, ['--require-root-anchor', '--require-anchor-density']);
});
