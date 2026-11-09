import { test, expect } from '@playwright/test';
import { EditorApp, readProofEvents, readProofJson } from './helpers/app.js';
import type { ProofCheckpoint } from './helpers/app.js';
import { loadExamFixture } from './helpers/examFixture.js';
import { injectApiFault } from './helpers/faults.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * 試験の開始時に Workers へ届かず、後から網が戻る (#236)。
 *
 * - 試験開始ゲートの人間確認 (Turnstile + session/start の先行取得) が決着していなくても、解錠と編集開始は
 *   待たない。#0 humanAttestation は合成の印 (`verified: false` / `signature: 'unsigned'`) になる
 * - 署名専用 token が得られない間も export は止まらない (取得が決着しない session/start を塞いだまま export する。
 *   export が token を待つなら、ここで終わらない)。その proof の checkpoint は署名されない
 * - 網が戻る (`online`) と署名専用 token を取り直し、以降の checkpoint が署名される。#0 は書き換えない
 *
 * 「起動時に Workers へ届かない」は session/start だけを応答させない (`hang`) ことで作る。setOffline は
 * 読込後にだけ使う (fault-network.spec.ts と同じ。読込前に入れると Monaco などの読み込みまで遮断される)。
 * ここでは `online` イベントを起こすためだけに、塞ぎを外した後でオフライン → オンラインと切り替える。
 */

const fixture = loadExamFixture();

/** checkpoint は 100 イベントごとか 10 秒ごとにできる (CheckpointManager)。それを確実に超える打鍵。 */
const CHECKPOINT_TRIGGER_CODE = 'int total = 0;\nfor (int i = 0; i < 10; i++) {\ntotal += i;\n}\n';

test('exam: 開始時に session/start が応答しなくても待たずに解錠・export でき、網が戻ると署名 token を取り直して以降の checkpoint が署名される', async ({
  page,
  context,
}) => {
  if (!fixture) {
    if (process.env.CI)
      throw new Error('exam fixture is missing: `npm run setup -w @typedcode/e2e` did not generate it');
    test.skip(true, 'exam fixture 未生成 (npm run setup -w @typedcode/e2e で作る)');
    return;
  }

  const sessionStart = await injectApiFault(page, 'session/start', 'hang');
  const app = new EditorApp(page);
  await app.openModeFresh('exam', { screenShare: 'share', waitReady: false });
  await expect.poll(() => app.appState()).toBe('gate');

  await test.step('ゲートの人間確認が決着していなくても解錠できる', async () => {
    // 先行取得が session/start まで進んだ (注入が空振りしていない) のを見てから、決着を待たずに解錠する。
    await expect.poll(() => sessionStart.calls(), { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(page.locator('#exam-gate-attestation')).toHaveAttribute('data-attestation-state', 'pending');
    await app.unlockExam(fixture.packagePath, fixture.code);
  });

  await app.typeCode(CHECKPOINT_TRIGGER_CODE);
  await app.waitForSynced();

  await test.step('署名専用 token が得られない間も export は止まらず、checkpoint は署名されない', async () => {
    const zipPath = await app.exportViaLogButton();
    const events = await readProofEvents(zipPath);
    expect(events[0]?.type).toBe('humanAttestation');
    const attestation = events[0]?.data as { verified?: boolean; signature?: string } | undefined;
    expect(attestation?.verified, JSON.stringify(attestation)).toBe(false);
    expect(attestation?.signature).toBe('unsigned');
    const proof = (await readProofJson(zipPath)) as { checkpoints?: ProofCheckpoint[] };
    const checkpoints = proof.checkpoints ?? [];
    expect(checkpoints.length, 'the typing created checkpoints').toBeGreaterThan(0);
    expect(checkpoints.filter((cp) => cp.signature)).toEqual([]);
  });

  await test.step('網が戻ると署名 token を取り直し、以降の checkpoint が署名される', async () => {
    let navigations = 0;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations += 1;
    });
    const signed = page.waitForResponse(
      (response) => response.url().endsWith('/api/checkpoint/sign') && response.status() === 200,
      { timeout: 90_000 }
    );
    await sessionStart.remove();
    await context.setOffline(true);
    await page.waitForTimeout(500);
    await context.setOffline(false);
    await signed;
    expect(navigations, 'page must not reload across the offline window').toBe(0);

    await app.typeCode('int more = 1;\n');
    await app.waitForSynced();
    const zipPath = await app.exportViaLogButton();

    const proof = (await readProofJson(zipPath)) as { checkpoints?: ProofCheckpoint[] };
    const signedCheckpoints = (proof.checkpoints ?? []).filter((cp) => cp.signature);
    expect(signedCheckpoints.length, 'checkpoints are signed after the network came back').toBeGreaterThan(0);
    // 遅れて得た token は #0 に焼かない (#0 は解錠時に記録済み)
    const events = await readProofEvents(zipPath);
    expect((events[0]?.data as { verified?: boolean } | undefined)?.verified).toBe(false);

    const result = runVerifyCli(zipPath, ['--mode', 'fast', '--exam-package', fixture.packagePath], {
      examAuthorityKeys: true,
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  });
});
