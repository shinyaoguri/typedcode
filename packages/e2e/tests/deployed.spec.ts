import { test, expect } from '@playwright/test';
import { CHECKPOINT_PUBLIC_KEYS } from '../../shared/src/checkpointKeys/registry.js';
import { EditorApp, readProofJson } from './helpers/app.js';
import type { ProofCheckpoint } from './helpers/app.js';
import { runVerifyCliWithVerdicts } from './helpers/verifyCli.js';
import { VerifyWebApp, expectWebCliParity, proofNames } from './helpers/verifyWeb.js';

/**
 * デプロイ済みの staging をブラウザで通す round-trip (#655)。
 *
 * 他の spec の相手は手元のサーバ (vite dev / 手元で build した dist の vite preview + wrangler dev) だけで、
 * secrets を入れて build し直した配信物・本物の staging Worker (session/start・checkpoint/sign・CORS)・
 * Cloudflare の配信 (COEP などのヘッダの下での Turnstile の読み込み) の組み合わせを利用者の操作として
 * 通したことが無い。ここでは `/casual` で打鍵 → export → verify-cli (fast) と、同じ ZIP を配信物の
 * `/verify/` に入れるところまでを、配信物の URL に対して 1 本で通す。
 *
 * 見るもの:
 * - console error / pageerror が 0 件 (production-build.spec と同じ収集。Cloudflare Web Analytics は除外)
 * - verify-cli (`--mode fast`) が pass
 * - proof に署名付き checkpoint が載り、その keyId (と sessionStartToken の keyId) がすべて staging の鍵。
 *   手元の E2E 鍵ではなく staging の Worker が署名した証拠
 * - sessionStartToken があり root がアンカーされ、`--analysis-bundle` の temporal が `anchored`
 *   (happy-path.spec の ④⑤ と同じ判定)
 * - 配信物の `/verify/` の判定の状態契約が verify-cli の判定と一致する (`expectWebCliParity`)
 *
 * 見ないもの: 本物の Turnstile。staging (と PR プレビュー) は Cloudflare の公開テストキー (常に通る) で
 * 動かし、staging の Worker はテストキーの結果を staging でだけ受け付ける (ADR-0049)。production は
 * 本物の Turnstile なので headless では通らず、この spec を当てない (staging の鍵の assert でも落ちる)。
 *
 * dev フック (`__tcTestInsertBlock` / `__tcTestSnapshot`) は配信物に無いので使わない (打鍵は実キー入力)。
 *
 * 実行 (専用の playwright.deployed.config.ts。既定・build の config からは外してある):
 *   E2E_DEPLOYED_URL=https://staging.typedcode.pages.dev npm run test:deployed -w @typedcode/e2e
 * CI では deploy.yml の e2e-staging job が、deploy-staging が出したその deploy の URL を渡す。
 */

/**
 * staging の Worker の checkpoint 署名鍵 (`packages/shared/src/checkpointKeys/registry.ts` の「staging環境」)。
 * registry のエントリは環境を機械可読に持たない (コメントだけ) ので、keyId をここに置き、registry に
 * 載っていて active であることを下の test で確かめる。staging の鍵を替えたら (registry に足した上で) ここを直す。
 */
const STAGING_CHECKPOINT_KEY_ID = 'tcp-202606-0e46c9';

/** Cloudflare Web Analytics のビーコン。配信物に差し込まれても本件と無関係 (production-build.spec と同じ)。 */
const isIrrelevant = (text: string) => /cloudflareinsights\.com|cdn-cgi\/rum/.test(text);

test('staging の期待する署名鍵が registry に active で載っている', () => {
  const entry = CHECKPOINT_PUBLIC_KEYS.find((k) => k.keyId === STAGING_CHECKPOINT_KEY_ID);
  expect(entry, `${STAGING_CHECKPOINT_KEY_ID} が registry.ts に無い`).toBeDefined();
  expect(entry!.status).toBe('active');
});

test('deployed: casual で打鍵 → export が staging の署名付きで verify-cli と配信物の /verify/ を通る', async ({
  page,
  baseURL,
}) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // 読み込みの失敗 (`Failed to load resource: net::ERR_FAILED`) は本文に URL を含まず、URL は location にだけ載る。
    // staging の配信には Web Analytics のビーコンが差し込まれ、/cdn-cgi/rum への送信が CORS で落ちる (#655 で実測)。
    const { url } = msg.location();
    if (isIrrelevant(msg.text()) || isIrrelevant(url)) return;
    consoleErrors.push(url ? `${msg.text()} (${url})` : msg.text());
  });
  page.on('pageerror', (err) => {
    if (!isIrrelevant(err.message)) pageErrors.push(err.message);
  });
  const collected = () => `pageerror:\n${pageErrors.join('\n')}\nconsole.error:\n${consoleErrors.join('\n')}`;

  // ① 配信物の editor で打鍵して export する。
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int main(){return 0;}\n');
  const zipPath = await app.exportCurrentTab();

  // ② verify-cli (fast) が pass する。三層保証は `--analysis-bundle` から読む。
  const cli = runVerifyCliWithVerdicts(zipPath, ['--mode', 'fast']);
  expect(cli.passed, cli.stdout + cli.stderr).toBe(true);
  expect(cli.verdicts.length).toBeGreaterThan(0);
  expect(cli.verdicts[0]!.valid).toBe(true);

  // ③ staging の Worker が session を開始し、checkpoint に署名した。keyId が手元の E2E 鍵 (setup-env.mjs が
  // 生成する tcp-e2e-…) や production の鍵なら、別の Worker が応答している。
  const proof = (await readProofJson(zipPath)) as {
    rootAnchored?: boolean;
    sessionStartToken?: { keyId?: string };
    checkpoints?: ProofCheckpoint[];
  };
  expect(proof.rootAnchored, 'root is anchored by the session start token').toBe(true);
  expect(proof.sessionStartToken, 'proof carries the session start token').toBeTruthy();
  expect(proof.sessionStartToken!.keyId, 'session start token is signed by the staging key').toBe(
    STAGING_CHECKPOINT_KEY_ID
  );
  const signedKeyIds = (proof.checkpoints ?? []).flatMap((cp) => (cp.signature ? [cp.signature.keyId] : []));
  expect(signedKeyIds.length, 'at least one checkpoint carries a signed envelope').toBeGreaterThan(0);
  expect(new Set(signedKeyIds), 'every signed checkpoint is signed by the staging key').toEqual(
    new Set([STAGING_CHECKPOINT_KEY_ID])
  );

  // ④ 最終イベントまで署名が届いている (happy-path.spec の ⑤ と同じ)。
  expect(cli.verdicts[0]!.assurance.temporal, 'an honest session is anchored up to its final event').toBe('anchored');

  // ⑤ 同じ ZIP を配信物の /verify/ に入れ、判定の状態契約が verify-cli の判定と一致する。
  const names = await proofNames(zipPath);
  expect(names.length).toBeGreaterThan(0);
  const web = new VerifyWebApp(page, new URL('/verify/', baseURL).toString());
  await web.open('fast');
  await web.load([zipPath]);
  expectWebCliParity(await web.readVerdicts(names), cli);

  // ⑥ editor と verify のどちらでも console / page エラーが出ていない。
  expect(pageErrors, collected()).toEqual([]);
  expect(consoleErrors, collected()).toEqual([]);
});
