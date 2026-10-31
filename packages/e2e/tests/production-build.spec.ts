import { basename } from 'node:path';
import { test, expect } from '@playwright/test';
import { EditorApp, listProofEntries } from './helpers/app.js';
import { VerifyWebApp } from './helpers/verifyWeb.js';

/**
 * 本番ビルド (vite build の出力) に対するスモーク。
 *
 * 他の spec はすべて vite dev サーバに対して走るため、**チャンク分割や
 * バンドル変換に起因する退行を原理的に検出できない**。実際に #255 では
 * `vite-plugin-top-level-await` が monaco の関数巻き上げを壊し、本番ビルドの
 * エディタが一切起動しない状態で CI が緑のまま main に載った。
 *
 * この spec だけは `vite preview` (= dist の配信) を対象に、専用の
 * `playwright.build.config.ts` で実行する (`npm run test:build -w @typedcode/e2e`)。
 * 既定の `playwright.config.ts` は testIgnore でこのファイルを外している
 * (dev サーバに対して走らせても目的の退行を検出できないため)。
 *
 * オラクルは「console / pageerror が出ない」「Monaco が実際にマウントされる」
 * 「打鍵がエディタに入る」の 3 点と、verify の本番ビルド (`/verify/` 配下) が proof を読んで
 * 状態契約の属性を出すこと。重い round-trip と判定の中身 (Web↔CLI パリティ) は dev 側の
 * spec (verify-web.spec.ts) が担うので、ここには増やさない (CLAUDE.md「CI 時間を意識」)。
 * dist には dev フックが無いので、dev 限定 API に依存しないこと。
 */
test('production build: エディタが console エラーなくマウントし打鍵できる', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  // Cloudflare Web Analytics のビーコン (cloudflareinsights.com) は preview には
  // 存在しないが、将来 dist に混ざっても本件と無関係なので除外しておく。
  const isIrrelevant = (text: string) => /cloudflareinsights\.com|cdn-cgi\/rum/.test(text);

  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isIrrelevant(msg.text())) consoleErrors.push(msg.text());
  });
  // Uncaught TypeError はここに来る (#255 の `Class extends value undefined` / `Le is not a function`)。
  page.on('pageerror', (err) => {
    if (!isIrrelevant(err.message)) pageErrors.push(err.message);
  });

  await page.goto('/casual?reset');

  // ① Monaco が実際にマウントされる。#255 では .monaco-editor が生えないまま止まった。
  // ここで落ちると素の TimeoutError になり原因が見えないので、収集済みのエラーを添えて投げ直す。
  const collected = () => `pageerror:\n${pageErrors.join('\n')}\nconsole.error:\n${consoleErrors.join('\n')}`;
  try {
    await page.locator('.monaco-editor .view-lines').first().waitFor({ state: 'visible', timeout: 30_000 });
  } catch (cause) {
    throw new Error(`Monaco がマウントされなかった (#255 と同じ症状)。\n${collected()}`, { cause });
  }

  // ② イベント記録が動いている (#0 humanAttestation で 1 以上になる)。
  await expect
    .poll(
      async () => {
        const txt = (await page.locator('#event-count').textContent()) ?? '0';
        return Number.parseInt(txt.replace(/[^0-9]/g, ''), 10) || 0;
      },
      { timeout: 30_000 }
    )
    .toBeGreaterThan(0);

  // ③ 1 文字打てて、それがエディタに入る。
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.type('int main(){return 0;}');
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('int main');

  // ④ console / page エラーが 1 件も出ていない。これが #255 の再現オラクル。
  expect(pageErrors, collected()).toEqual([]);
  expect(consoleErrors, collected()).toEqual([]);
});

test('production build: verify (/verify/) が proof を読んで判定の状態契約を出す', async ({ page, baseURL }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  // proof は本番ビルドの editor で作る (dev フックは使わない)。
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int main(){return 0;}\n');
  const zipPath = await app.exportCurrentTab();
  const names = (await listProofEntries(zipPath)).map((n) => basename(n));
  expect(names.length).toBeGreaterThan(0);

  // deploy と同じ配置: editor の dist の `verify/` (base: '/verify/' でビルドされた verify)。
  const web = new VerifyWebApp(page, new URL('/verify/', baseURL).toString());
  await web.open('fast');
  const states = await web.load([zipPath]);
  expect(states.length, 'ZIP のファイルがサイドバーに並ぶ').toBeGreaterThan(0);

  // 判定の値そのものは dev 側 (verify-web.spec.ts) が CLI と突き合わせる。ここは「本番ビルドでも
  // 検証 Worker が動いて判定まで届き、状態契約の属性が出る」ことだけを見る。
  for (const v of await web.readVerdicts(names)) {
    expect(v.status, JSON.stringify(v)).not.toBe('error');
    expect(['proven', 'partial'], JSON.stringify(v)).toContain(v.integrity);
    expect(v.temporal, JSON.stringify(v)).not.toBeNull();
    expect(['true', 'false'], JSON.stringify(v)).toContain(v.pureTyping);
    expect(['verified', 'partial'], JSON.stringify(v)).toContain(v.level);
  }
  expect(pageErrors, pageErrors.join('\n')).toEqual([]);
});
