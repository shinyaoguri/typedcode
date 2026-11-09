import { test, expect } from '@playwright/test';
import { EditorApp, readProofJson } from './helpers/app.js';
import { injectApiFault } from './helpers/faults.js';
import {
  CHECKPOINT_TRIGGER_CODE,
  expectAcceptedWith,
  expectPassesWithoutFlags,
  expectRejectedByPolicy,
  signedCheckpoints,
  unsignedTailEvents,
  waitForSignedCheckpoint,
  type ProofForPolicy,
} from './helpers/strictPolicy.js';

/**
 * verify-cli の `--require-anchor-density` (ADR-0016) が、署名 cp はあるが疎な実 proof を拒否する (#590)。
 * 疎な proof は「1 個目の署名の後で `/api/checkpoint/sign` を落とし、最後の署名から 500 イベント
 * (`MAX_ANCHOR_GAP_EVENTS`) を超えて打つ」で作る。打鍵が多く遅い CI で数分かかるので、
 * verify-cli-strict.spec.ts とはファイルを分けている (helpers/strictPolicy.ts の doc)。
 */

/**
 * 密度ゲートの閾値 (shared の `MAX_ANCHOR_GAP_EVENTS` = 500) を確実に超える、署名の止まった後の
 * イベント数。export の前後に積まれるイベントの揺れを見込んで余裕を取る。
 */
const UNSIGNED_TAIL_TARGET_EVENTS = 650;

/** 1 回に打つ分 (打鍵 1 文字で複数のイベントが積まれる)。 */
const FILLER_CHUNK = 'total = total + 1;\n'.repeat(4);

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
