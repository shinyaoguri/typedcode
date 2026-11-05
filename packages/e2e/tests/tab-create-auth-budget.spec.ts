import { test, expect } from '@playwright/test';
import { EditorApp, listProofEntries, readProofJson } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * #375: タブ作成時の認証 (Turnstile のスクリプト読込 + チャレンジ + session/start) は
 * TAB_CREATE_VERIFICATION_BUDGET_MS (15 秒) で打ち切り、非アンカーで編集を始める。
 *
 * 予算が無いと、Turnstile の配信元にも Workers にも届かない網では、スクリプト読込のリトライ
 * (10 秒 × 3 + 待ち 1 + 2 秒) だけで 33 秒、チャレンジまで進めばさらに最大 3 分、打鍵を始められない。
 * ここでは両方を無応答にして、新規ファイルのクリックから予算 + 余裕 (5 秒) 以内に打鍵が記録されることを
 * 計時し、その proof が未アンカー (`rootAnchored: false`) のまま export・検証に通ることを確かめる。
 * class は export 前認証も best-effort (予算 15 秒) なので、同じ網のまま ZIP が出る。
 */

const WORKERS_PORT = Number(process.env.E2E_WORKERS_PORT ?? 8787);

/** タブ作成の認証の予算 (editor の TAB_CREATE_VERIFICATION_BUDGET_MS) */
const TAB_CREATE_BUDGET_MS = 15_000;
/** 予算切れの後、モーダルを閉じて #0 を記録し、打鍵を受け付けるまでの余裕 */
const TAB_READY_SLACK_MS = 5_000;

test('class: Turnstile も Workers も無応答でも、新規タブは予算内に打鍵を受け付け、未アンカーの proof が検証に通る (#375)', async ({
  page,
}) => {
  // 応答しない (route ハンドラが fulfill も continue もしない)。workers-hang-export.spec.ts と同じ手口。
  let turnstileCalls = 0;
  await page.route('https://challenges.cloudflare.com/**', () => {
    turnstileCalls += 1;
  });
  await page.route(`http://localhost:${WORKERS_PORT}/api/**`, () => {});

  const app = new EditorApp(page);
  // class は起動時にタブを作らない (ウェルカム画面)。タブを作るのは新規ファイルのクリック。
  await app.openModeFresh('class', { screenShare: 'share', waitReady: false });
  const newFile = page.locator('#welcome-new-file');
  await newFile.waitFor({ state: 'visible' });

  const clickedAt = Date.now();
  await newFile.click();
  await expect.poll(() => app.eventCount(), { timeout: TAB_CREATE_BUDGET_MS + TAB_READY_SLACK_MS }).toBeGreaterThan(0);
  const before = await app.eventCount();
  await app.typeCode('int late = 1;');
  await expect.poll(() => app.eventCount()).toBeGreaterThan(before);
  const readyMs = Date.now() - clickedAt;

  // 注入が空振りしていない (タブ作成の認証が Turnstile のスクリプトを取りに行った)
  expect(turnstileCalls).toBeGreaterThan(0);
  expect(readyMs).toBeLessThan(TAB_CREATE_BUDGET_MS + TAB_READY_SLACK_MS);
  await app.expectConsistent();
  expect((await app.snapshot()).tabs[0]!.content).toBe('int late = 1;');

  const zipPath = await app.exportCurrentTab();
  expect(await listProofEntries(zipPath)).toHaveLength(1);

  // root は session/start の token 無しで確定している (予算切れ = 非アンカー)
  const proof = await readProofJson(zipPath);
  expect(proof.rootAnchored).toBe(false);
  expect(proof.sessionStartToken).toBeUndefined();

  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
});
