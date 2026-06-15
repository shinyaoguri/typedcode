import { defineConfig, devices } from '@playwright/test';

/**
 * E2E は「実物のエディタを動かして証明を出力し、それを verify-cli で検証する」
 * round-trip を基本形にする (UI の見た目ではなく、暗号的に検証可能な成果物を
 * オラクルにする)。詳細は packages/e2e/README.md。
 *
 * 2 つのローカルサーバを起動する:
 *   - workers (wrangler dev :8787): /api/session/start・/api/verify-captcha・署名 CP
 *   - editor  (vite dev   :5173): テスト対象アプリ
 *
 * editor/.env は既に Cloudflare の Turnstile テストキー (1x...AA = 常に pass) と
 * VITE_API_URL=http://localhost:8787 を指すため、追加設定なしでフルスタックが回る。
 */

const EDITOR_PORT = Number(process.env.E2E_EDITOR_PORT ?? 5173);
const WORKERS_PORT = Number(process.env.E2E_WORKERS_PORT ?? 8787);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${EDITOR_PORT}`;
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  // PoSW (Web Worker でのハッシュ計算) と export + verify-cli の full 再計算が絡むため重い。
  // 遅い CI ランナーでも収まるよう長めに取る。
  timeout: 300_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  // PoSW Worker はタブ間で CPU を食い合うので E2E は直列寄りにして安定させる。
  workers: 1,
  reporter: isCI
    ? [['list'], ['html', { open: 'never' }], ['github']]
    : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: isCI ? 'retain-on-failure' : 'off',
    // 外部ペースト/内部ペーストのシナリオでクリップボードを実操作するため付与。
    permissions: ['clipboard-read', 'clipboard-write'],
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            // getDisplayMedia (画面共有) を headless でも自動許可・自動ソース選択する。
            // ピッカー UI を出さず本物の MediaStream を得てキャプチャ経路を検証する。
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--auto-select-desktop-capture-source=Entire screen',
          ],
        },
      },
    },
  ],

  webServer: [
    {
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
      name: 'editor',
      command: 'npm run dev -w @typedcode/editor',
      cwd: '../..',
      port: EDITOR_PORT,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
