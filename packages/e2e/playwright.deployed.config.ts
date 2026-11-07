import { defineConfig, devices } from '@playwright/test';

/**
 * デプロイ済みの配信物 (staging の Pages) に対して round-trip を通す Playwright 設定 (#655)。
 *
 * 既定の `playwright.config.ts` (vite dev) と `playwright.build.config.ts` (手元で build した dist を
 * vite preview) はどちらも手元のサーバが相手で、secrets を入れて build し直した配信物・本物の Workers・
 * Cloudflare の配信 (ヘッダ・CORS) の組み合わせは通らない。ここではサーバを一切起こさず、
 * `E2E_DEPLOYED_URL` で渡した URL に `tests/deployed.spec.ts` だけを走らせる。
 *
 * 実行: E2E_DEPLOYED_URL=https://staging.typedcode.pages.dev npm run test:deployed -w @typedcode/e2e
 *
 * 当てるのは staging だけ (ADR-0049: staging は Turnstile の公開テストキーで動かす。production は本物の
 * Turnstile なので headless では通らず、spec は staging の署名鍵を期待する)。CI では deploy.yml の
 * e2e-staging job が、deploy-staging が出したその deploy の URL を渡す。
 *
 * webServer と globalSetup (作業ツリーの照合) は持たない。相手は手元のプロセスではないので照合するものが無い。
 */

const DEPLOYED_URL = process.env.E2E_DEPLOYED_URL;
if (!DEPLOYED_URL) {
  throw new Error(
    'E2E_DEPLOYED_URL が未設定です。デプロイ済みの配信物の URL を渡してください ' +
      '(例: E2E_DEPLOYED_URL=https://staging.typedcode.pages.dev npm run test:deployed -w @typedcode/e2e)'
  );
}
// 綴りの誤り (スキーム抜けなど) を、全テストが goto で落ちる前にここで止める。
if (!URL.canParse(DEPLOYED_URL)) {
  throw new Error(`E2E_DEPLOYED_URL が URL として読めません: ${DEPLOYED_URL}`);
}

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  // dev フック (`__tcTestInsertBlock` / `__tcTestSnapshot`) は配信物に無いので、それに依存しない専用 spec だけを選ぶ。
  testMatch: /deployed\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  forbidOnly: isCI,
  // 相手はネットワーク越しの本物の配信物なので、一過性の失敗を 1 回だけ吸収する (dev / build 設定と同じ)。
  retries: isCI ? 1 : 0,
  workers: 1,
  reporter: isCI ? [['list'], ['html', { open: 'never' }], ['github']] : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: DEPLOYED_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: isCI ? 'retain-on-failure' : 'off',
    // 1 つの操作・遷移の上限 (#584)。理由は playwright.build.config.ts と同じ。
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
