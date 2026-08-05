import { defineConfig, devices } from '@playwright/test';

/**
 * 本番ビルド (dist) 専用の Playwright 設定。
 *
 * 既定の `playwright.config.ts` は vite **dev** サーバを起動するため、チャンク
 * 分割やバンドル変換に起因する退行を原理的に検出できない (#255: dev では console
 * エラー 0 件、本番ビルドだけエディタが起動しない状態で CI が緑のまま main に載った)。
 * ここでは editor を `vite build` してから `vite preview` で dist を配信し、
 * `tests/production-build.spec.ts` だけを走らせる。
 *
 * 実行: npm run test:build -w @typedcode/e2e
 *
 * dev 用の設定とは webServer / testMatch 以外を共有しない (dev 側の挙動を一切
 * 変えないため意図的に別ファイルにしている)。
 */

const PREVIEW_PORT = Number(process.env.E2E_PREVIEW_PORT ?? 4173);
const WORKERS_PORT = Number(process.env.E2E_WORKERS_PORT ?? 8787);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PREVIEW_PORT}`;
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  // 本番ビルドを対象にできる spec だけを明示的に選ぶ。dev 前提のヘルパ
  // (`window.__tcTestInsertBlock` など) を使う spec は dist に存在しない。
  testMatch: /production-build\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1,
  reporter: isCI ? [['list'], ['html', { open: 'never' }], ['github']] : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: isCI ? 'retain-on-failure' : 'off',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      // Turnstile / セッション開始 API。無いと fetch 失敗が console エラーとして
      // 出てしまい、本題 (バンドル起因のエラー) と区別がつかなくなる。
      name: 'workers',
      command: 'npm run dev -w @typedcode/workers',
      cwd: '../..',
      port: WORKERS_PORT,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // 検証対象は「いま build した dist」でなければ意味がないので、build を
      // コマンドに含め `reuseExistingServer: false` で既存 preview の再利用も禁じる。
      name: 'editor-preview',
      command: `npm run build -w @typedcode/editor && npm run preview -w @typedcode/editor -- --port ${PREVIEW_PORT} --strictPort`,
      cwd: '../..',
      port: PREVIEW_PORT,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
