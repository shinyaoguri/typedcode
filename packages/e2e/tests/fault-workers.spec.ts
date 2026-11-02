import { test, expect } from '@playwright/test';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { EditorApp, listProofEntries, readProofJson } from './helpers/app.js';
import type { ProofCheckpoint } from './helpers/app.js';
import { injectApiFault } from './helpers/faults.js';
import type { ApiFault } from './helpers/faults.js';
import { runVerifyCli, runVerifyCliWithVerdicts } from './helpers/verifyCli.js';

/**
 * Workers の API 障害 (#435): `/api/session/start` と `/api/checkpoint/sign` が 503・abort・hang
 * のどれで失敗しても、編集と export は止まらず、proof は時刻アンカーの無い (または弱い) proof として
 * 検証に通る (ADR-0017 (b) の degraded fallback と ADR-0004 の「未アンカーも valid」)。
 *
 * 注入は API を 1 つずつ選ぶ (`**\/api/**` をまとめて塞ぐと casual の export 前認証まで落ちる)。
 * verify-cli は `--mode fast` なので integrity の上限は `partial` (PoSW を再計算しない = #214)。
 */

/** 全 `*_proof.json` をトップレベルごと読む (rootAnchored / sessionStartToken をタブごとに見る)。 */
async function readAllProofJson(zipPath: string): Promise<Array<Record<string, unknown>>> {
  const zip = await JSZip.loadAsync(await readFile(zipPath));
  const names = Object.keys(zip.files).filter((n) => n.endsWith('_proof.json'));
  return Promise.all(
    names.map(async (n) => JSON.parse(await zip.files[n]!.async('string')) as Record<string, unknown>)
  );
}

/** hang は 1 回あたり fetch 上限 (10 秒) ぶん待たされるので、タブ作成の待ちを延ばす。 */
const TAB_CREATE_TIMEOUT_MS = 45_000;

for (const fault of ['503', 'abort', 'hang'] as const satisfies readonly ApiFault[]) {
  test(`session/start が ${fault} でも、起動時もタブ作成時も編集でき、proof は未アンカーで検証に通る`, async ({
    page,
  }) => {
    // 起動時の既定タブ (main.ts の casual の createTab) から効かせるため、goto の前に入れる。
    const injected = await injectApiFault(page, 'session/start', fault);
    const app = new EditorApp(page);
    await app.openCasualFresh();

    // 起動時: 既定タブで編集できる。注入が空振りしていない (既定タブの session/start を受けた)。
    expect(injected.calls(), 'startup tab must hit the injected session/start').toBe(1);
    await app.typeCode('int a = 1;\n');
    await app.expectConsistent();

    // タブ作成時: 追加したタブでも session/start が失敗し、それでも編集できる。
    // app.addTab の待ち (expect の既定 15 秒) では hang の 10 秒 + Turnstile に足りないので、ここで待つ。
    await page.locator('#add-tab-btn').click();
    await expect.poll(() => app.tabs().then((t) => t.length), { timeout: TAB_CREATE_TIMEOUT_MS }).toBe(2);
    await expect.poll(() => injected.calls()).toBe(2);
    await expect.poll(() => app.eventCount(), { timeout: TAB_CREATE_TIMEOUT_MS }).toBeGreaterThan(0);
    await app.typeCode('int b = 2;\n');
    await app.expectConsistent();

    await app.waitForSynced();
    const zipPath = await app.exportAllTabs();
    expect(await listProofEntries(zipPath)).toHaveLength(2);

    // どちらのタブの proof も root が未アンカー (session/start のトークンを持たない)。
    const proofs = await readAllProofJson(zipPath);
    for (const proof of proofs) {
      expect(proof.rootAnchored).toBe(false);
      expect(proof.sessionStartToken).toBeUndefined();
    }

    // 検証は通り、時刻アンカーは無い。sign はトークン前提 (ADR-0027) なので署名 cp も無く unanchored。
    const result = runVerifyCliWithVerdicts(zipPath, ['--mode', 'fast']);
    expect(result.passed, result.stdout + result.stderr).toBe(true);
    expect(result.verdicts).toHaveLength(2);
    for (const v of result.verdicts) {
      expect(v.valid).toBe(true);
      expect(v.assurance.integrity).toBe('partial');
      expect(v.assurance.temporal).toBe('unanchored');
    }

    // 負の制御: root アンカーを必須にすると拒否される (未アンカーであることを CLI 自身が見ている)。
    const strict = runVerifyCli(zipPath, ['--mode', 'fast', '--require-root-anchor']);
    expect(strict.exitCode, strict.stdout + strict.stderr).toBe(1);
  });
}

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
