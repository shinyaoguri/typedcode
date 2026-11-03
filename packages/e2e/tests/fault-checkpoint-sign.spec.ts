import { test, expect } from '@playwright/test';
import { EditorApp, readProofJson } from './helpers/app.js';
import type { ProofCheckpoint } from './helpers/app.js';
import { injectApiFault } from './helpers/faults.js';
import type { ApiFault } from './helpers/faults.js';
import { runVerifyCliWithVerdicts } from './helpers/verifyCli.js';

/**
 * Workers の API 障害 (#435): `/api/checkpoint/sign` が 503・abort で失敗しても export でき、proof は
 * 署名の無い checkpoint のまま (root は session/start で既にアンカー済み) 検証に通る
 * (ADR-0017 (b) の degraded fallback)。
 *
 * `/api/session/start` の障害は fault-session-start.spec.ts。API ごとにファイルを分けている理由
 * (Slow Test の回避 / #525) と注入が漏れない根拠はそちらの冒頭を参照。
 *
 * verify-cli は `--mode fast` なので integrity の上限は `partial` (PoSW を再計算しない = #214)。
 */

/** checkpoint は 100 イベントごとか 10 秒ごとにできる (CheckpointManager)。それを確実に超える打鍵。 */
const CHECKPOINT_TRIGGER_CODE = 'int total = 0;\nfor (int i = 0; i < 10; i++) {\ntotal += i;\n}\n';

for (const fault of ['503', 'abort'] as const satisfies readonly ApiFault[]) {
  test(`checkpoint/sign が ${fault} でも export でき、署名の無い checkpoint のまま検証に通る`, async ({ page }) => {
    // 401 TOKEN_INVALID は別経路 (トークンの取り直し) なので、ここでは 503 / abort だけを使う。
    const injected = await injectApiFault(page, 'checkpoint/sign', fault);
    const app = new EditorApp(page);
    await app.openCasualFresh();

    await app.typeCode(CHECKPOINT_TRIGGER_CODE);
    // checkpoint ができて sign が呼ばれた (= 注入が空振りしていない) ことを待つ。
    await expect.poll(() => injected.calls(), { timeout: 30_000 }).toBeGreaterThan(0);
    await app.waitForSynced();

    const zipPath = await app.exportCurrentTab();
    const proof = (await readProofJson(zipPath)) as { rootAnchored?: boolean; checkpoints?: ProofCheckpoint[] };
    // session/start は生きているので root はアンカーされている。
    expect(proof.rootAnchored).toBe(true);
    const checkpoints = proof.checkpoints ?? [];
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(checkpoints.filter((cp) => cp.signature)).toEqual([]);

    // root だけのサーバ時刻証拠 = temporal は partial。
    const result = runVerifyCliWithVerdicts(zipPath, ['--mode', 'fast']);
    expect(result.passed, result.stdout + result.stderr).toBe(true);
    expect(result.verdicts).toHaveLength(1);
    expect(result.verdicts[0]!.assurance.integrity).toBe('partial');
    expect(result.verdicts[0]!.assurance.temporal).toBe('partial');
  });
}
