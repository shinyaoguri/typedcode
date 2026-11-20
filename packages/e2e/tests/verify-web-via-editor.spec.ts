import { test, expect } from '@playwright/test';
import { EditorApp } from './helpers/app.js';
import { runVerifyCliWithVerdicts } from './helpers/verifyCli.js';
import { VerifyWebApp, expectWebCliParity, proofNames, typeAndExport } from './helpers/verifyWeb.js';

/**
 * editor の dev サーバの `/verify/` から検証 Web に入れる (#829)。
 *
 * エディタと作問画面の「証明を検証」のリンクは `/verify/` を指す。dev の verify は `base: '/'` で別のポートに
 * 立つので、editor が `/verify` を転送すると返る HTML の `/src/main.ts` が editor のオリジンで解決され、
 * editor の main.ts が verify の HTML の上で走って落ちていた (`Editor container not found`)。いまは verify の
 * dev サーバへリダイレクトする (scripts/verify-redirect.mjs)。
 *
 * オラクルは「`/verify/` から入った検証 Web で pageerror / console の error が 0 件」「入れた ZIP の判定 (data-* の
 * 状態契約) が verify-cli と一致する」の 2 点。判定の中身の網羅は verify-web-parity が担う。
 */
test('editor の /verify/ から検証 Web に着き、エラーなく proof の ZIP を検証できる', async ({ page, baseURL }) => {
  const zipPath = await typeAndExport(new EditorApp(page));
  const names = await proofNames(zipPath);
  expect(names.length).toBeGreaterThan(0);

  // export までの editor のログは数えない (ここから先の検証 Web だけを見る)
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  // 外部の CDN (verify の index.html が読む Font Awesome) に届かないことは数えない。見るのは dev サーバが返した
  // ページとモジュールのエラー
  const isLocal = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const url = msg.location().url;
    if (url && !isLocal(url)) return;
    consoleErrors.push(`${msg.text()}${url ? ` (${url})` : ''}`);
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  const collected = () => `pageerror:\n${pageErrors.join('\n')}\nconsole.error:\n${consoleErrors.join('\n')}`;

  const web = new VerifyWebApp(page, new URL('/verify/', baseURL).toString());
  await web.open('fast');
  expect(new URL(page.url()).searchParams.get('mode'), 'クエリがリダイレクトで落ちない').toBe('fast');
  // モジュールの評価 (#829 では editor の main.ts が走って throw した) が済むまで待ってから、起動時のエラーを見る
  await page.waitForLoadState('load');
  expect(pageErrors, collected()).toEqual([]);
  expect(consoleErrors, collected()).toEqual([]);

  await web.load([zipPath]);
  const verdicts = await web.readVerdicts(names);
  const cli = runVerifyCliWithVerdicts(zipPath, ['--mode', 'fast']);
  expectWebCliParity(verdicts, cli);
  for (const v of verdicts) expect(v.status, JSON.stringify(v)).not.toBe('error');

  expect(pageErrors, collected()).toEqual([]);
  expect(consoleErrors, collected()).toEqual([]);
});
