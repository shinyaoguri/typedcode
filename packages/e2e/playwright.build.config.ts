import { defineConfig, devices } from '@playwright/test';
import { E2E_PORTS } from './ports.js';

/**
 * 本番ビルド (dist) 専用の Playwright 設定。
 *
 * 既定の `playwright.config.ts` は vite **dev** サーバを起動するため、チャンク
 * 分割やバンドル変換に起因する退行を原理的に検出できない (#255: dev では console
 * エラー 0 件、本番ビルドだけエディタが起動しない状態で CI が緑のまま main に載った)。
 * ここでは editor と verify を `vite build` し、deploy.yml と同じく editor の dist の
 * `verify/` に verify の dist を重ねてから (`scripts/stage-verify-dist.mjs`) `vite preview` で
 * 配信し、`tests/production-build.spec.ts` だけを走らせる。verify は `/verify/` 配下で開く。
 *
 * 実行: npm run test:build -w @typedcode/e2e
 *
 * dev 用の設定とは webServer / testMatch 以外を共有しない (dev 側の挙動を一切
 * 変えないため意図的に別ファイルにしている)。workers のポート (ports.ts) と作業ツリーの照合
 * (global-setup.ts の checkIdentities) だけは dev 設定と同じものを使う (#560)。
 */

const PREVIEW_PORT = Number(process.env.E2E_PREVIEW_PORT ?? 4173);
const WORKERS_PORT = E2E_PORTS.workers;
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
    // 1 つの操作・遷移の上限 (#584)。既定の 0 (上限なし) だと、止まった待ちはテスト全体の上限まで待ち、
    // 失敗もテストのタイムアウトとしか出ない。actionTimeout は context の既定 timeout になるので、click などの
    // 操作だけでなく、timeout を渡していない waitForFunction / waitForEvent / locator.waitFor もこの値で切れる。
    // 30 秒を超えて待つ箇所は、その呼び出しに timeout を渡す。
    // expect の待ちは上の expect.timeout が決める。
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  // テストより前に、起こした / 再利用した workers がこの作業ツリーのものかを照合する (#560)。
  // `port:` は TCP 応答しか見ないので、ローカルで reuseExistingServer が別の worktree の workers に
  // 黙ってつながるのを防ぐ。editor-preview は毎回起こすので照合しない (global-setup.build.ts)。
  globalSetup: './global-setup.build.ts',

  webServer: [
    {
      // Turnstile / セッション開始 API。無いと fetch 失敗が console エラーとして
      // 出てしまい、本題 (バンドル起因のエラー) と区別がつかなくなる。
      name: 'workers',
      // wrangler dev は env を読まないため、コマンド側に --port を渡す (無いと E2E_WORKERS_PORT を
      // 変えても既定の 8787 に上がる。#560)。作業ツリーの識別子は packages/workers の dev スクリプトが渡す。
      command: `npm run dev -w @typedcode/workers -- --port ${WORKERS_PORT}`,
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
      // verify は deploy と同じく editor の dist の `verify/` に重ねる (base: '/verify/' でビルドされる)。
      command: [
        'npm run build -w @typedcode/editor',
        'npm run build -w @typedcode/verify',
        'node packages/e2e/scripts/stage-verify-dist.mjs',
        `npm run preview -w @typedcode/editor -- --port ${PREVIEW_PORT} --strictPort`,
      ].join(' && '),
      // packages/editor/vite.config.ts は build 時も WORKERS_PORT を読み、VITE_API_URL がローカル既定なら
      // そのポートへ追従させる。渡さないと、ビルドした editor は E2E_WORKERS_PORT ではなく .env の値を叩く (#560)。
      env: { WORKERS_PORT: String(WORKERS_PORT) },
      cwd: '../..',
      port: PREVIEW_PORT,
      reuseExistingServer: false,
      timeout: 240_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
