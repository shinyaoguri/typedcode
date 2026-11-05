import { test, expect } from '@playwright/test';
import { EditorApp, listProofEntries } from './helpers/app.js';

/**
 * #324: Workers が無応答 (接続は張れるが応答が返らない) でも、best-effort のモード
 * (class/assignment/exam) の export が上限時間内に ZIP を出す。
 *
 * fetch に上限が無いと、session/start も verify-captcha も永久に待たされ、タブ作成も提出 ZIP も
 * 出ない (タブ作成は #375 で認証全体にも予算が付いた)。editor は fetch を WORKERS_FETCH_TIMEOUT_MS (10 秒) で打ち切り、export 前認証全体も
 * PRE_EXPORT_VERIFICATION_BUDGET_MS (15 秒) で打ち切って、失敗 attestation を残して ZIP を出す。
 * exam は封印パッケージの取込が要るため、同じ best-effort 経路を通る class で検証する。
 */

const WORKERS_PORT = Number(process.env.E2E_WORKERS_PORT ?? 8787);

/** タブ作成の認証の予算 (15 秒。#375) に、#0 の記録までの余裕を足した上限。 */
const TAB_READY_TIMEOUT_MS = 20_000;

/** 予算 (15 秒) に export 後半の処理 (セルフレビュー・ZIP 生成) の余裕を足した上限。 */
const EXPORT_DEADLINE_MS = 60_000;

test('class: Workers が無応答でも export が上限時間内に ZIP を出す (#324)', async ({ page }) => {
  // Workers の API を一切応答させない (route ハンドラが fulfill/continue しない = 無応答)。
  // Cloudflare の Turnstile (challenges.cloudflare.com) には触れず、Workers の origin だけに絞る。
  await page.route(`http://localhost:${WORKERS_PORT}/api/**`, () => {});

  const app = new EditorApp(page);
  // class は起動時にタブを作らない (ウェルカム画面)。新規ファイルのタブ作成は session/start の
  // fetch 上限 (10 秒) ぶん待たされるが、作成時の認証全体は TAB_CREATE_VERIFICATION_BUDGET_MS
  // (15 秒) で打ち切られて非アンカーで始まる (#375。#324 の時点ではスコープ外だった)。
  // 予算 + 余裕 (5 秒) で待つ。予算そのものの計時は tab-create-auth-budget.spec.ts が持つ。
  await app.openModeFresh('class', { screenShare: 'share', waitReady: false });
  await page.locator('#welcome-new-file').click();
  await expect.poll(() => app.eventCount(), { timeout: TAB_READY_TIMEOUT_MS }).toBeGreaterThan(0);
  await app.typeCode('let hung = 1;\n');

  const startedAt = Date.now();
  const zipPath = await app.exportCurrentTab();
  const elapsedMs = Date.now() - startedAt;

  expect(elapsedMs).toBeLessThan(EXPORT_DEADLINE_MS);
  const entries = await listProofEntries(zipPath);
  expect(entries.length).toBe(1);
});
