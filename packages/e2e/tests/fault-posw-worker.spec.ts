import { test, expect } from '@playwright/test';
import { EditorApp, listProofEntries } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * #701: PoSW の Worker が起動に失敗しても、記録の待ちがイベントごとの 30 秒期限で積み上がらない。
 *
 * Worker のスクリプトを route で 404 にすると、module Worker は生成直後に 1 度だけ `error` を出し、以後は何にも
 * 応答しない。editor は Worker を作ってから Turnstile を待ち、その後で TypingProof に渡すので、attach の時点で
 * 付く `onerror` だけではこの `error` を取り逃がす。以前は同じ個体を使い続け、#0 から 1 件ごとに
 * `WORKER_REQUEST_TIMEOUT_MS` (30 秒) を待ってメインスレッドで計算していた (記録は直列なので数文字で数分の
 * backlog になり、export の drain が停滞する)。今は生成と同じ同期区間で故障を観測し (`createPoswWorker`)、
 * attach の時点で故障済みの個体を捨てて、最初からメインスレッドのフォールバックで掃く。
 */

/** 注入の手口: PoSW Worker のスクリプト (Vite dev では `poswWorker.ts?worker_file&type=module`) を 404 にする。 */
const POSW_WORKER_SCRIPT = /poswWorker\.ts/;

/**
 * backlog が掃けるまでの上限。フォールバック (メインスレッドの PoSW 反復) で 1 件 数十〜数百 ms、
 * 下の打鍵で 50 件前後。故障した Worker を使い続けると 1 件ごとに 30 秒かかり、この上限を必ず超える。
 */
const DRAIN_TIMEOUT_MS = 25_000;

test('casual: PoSW Worker の起動失敗を注入しても、backlog が掃けて export が verify-cli (fast) を通る (#701)', async ({
  page,
}) => {
  let workerScriptRequests = 0;
  await page.route(POSW_WORKER_SCRIPT, async (route) => {
    workerScriptRequests += 1;
    await route.fulfill({ status: 404, body: 'injected: PoSW worker unavailable' });
  });

  const app = new EditorApp(page);
  // waitReady は #0 の記録まで待つ (上限 30 秒)。故障した Worker の期限 (30 秒) を待つとここで落ちる
  await app.openCasualFresh();
  await app.typeCode('let a = 1;\n');

  await expect
    .poll(
      async () => {
        const snap = await app.snapshot();
        return snap.tabs.find((t) => t.id === snap.activeTabId)?.pendingCount;
      },
      { timeout: DRAIN_TIMEOUT_MS }
    )
    .toBe(0);
  // 注入が空振りしていない (Worker のスクリプトを取りに行き、404 を受けた)
  expect(workerScriptRequests).toBeGreaterThan(0);
  await app.expectConsistent();

  const zipPath = await app.exportAllTabs();
  expect(await listProofEntries(zipPath)).toHaveLength(1);

  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
});
