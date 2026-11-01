import { defineConfig, devices } from '@playwright/test';

/**
 * E2E は「実物のエディタを動かして証明を出力し、それを verify-cli で検証する」
 * round-trip を基本形にする (UI の見た目ではなく、暗号的に検証可能な成果物を
 * オラクルにする)。詳細は packages/e2e/README.md。
 *
 * 3 つのローカルサーバを起動する (ポートは既定値。E2E_EDITOR_PORT / E2E_WORKERS_PORT /
 * E2E_VERIFY_PORT で上書き可能):
 *   - workers (wrangler dev 既定 :8787): /api/session/start・/api/verify-captcha・署名 CP
 *   - editor  (vite dev   既定 :5173): テスト対象アプリ (use.baseURL)
 *   - verify  (vite dev   既定 :5174): 検証 Web。Workers は呼ばない (verify/AGENTS.md)。
 *     URL は helpers/verifyWeb.ts が E2E_VERIFY_URL から組み立てる (baseURL は editor のまま)
 *
 * editor/.env は既に Cloudflare の Turnstile テストキー (1x...AA = 常に pass) と
 * VITE_API_URL=http://localhost:8787 を指すため、追加設定なしでフルスタックが回る。
 */

const EDITOR_PORT = Number(process.env.E2E_EDITOR_PORT ?? 5173);
const WORKERS_PORT = Number(process.env.E2E_WORKERS_PORT ?? 8787);
const VERIFY_PORT = Number(process.env.E2E_VERIFY_PORT ?? 5174);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${EDITOR_PORT}`;
const isCI = !!process.env.CI;

// verify Web の URL は helpers/verifyWeb.ts が読む。config は Playwright の worker プロセスでも
// 評価されるので、ここで env に置けば spec 側へポートの既定値を二重に書かずに済む。
process.env.E2E_VERIFY_URL ??= `http://localhost:${VERIFY_PORT}/`;

export default defineConfig({
  testDir: './tests',
  // production-build.spec.ts は dist (vite preview) を対象にする専用 spec なので、
  // dev サーバ向けのこの設定からは外す。実行は playwright.build.config.ts
  // (`npm run test:build -w @typedcode/e2e`) が担う。
  testIgnore: /production-build\.spec\.ts$/,
  // `@shots` は人が見る証跡を撮るだけで何も assert しない (tests/shots.spec.ts / ADR-0036)。
  // 検査ではないので通常の実行と CI のシャードからは外し、`npm run shots` (SHOTS=1) のときだけ走らせる。
  grepInvert: process.env.SHOTS === '1' ? undefined : /@shots/,
  // PoSW (Web Worker でのハッシュ計算) と export + verify-cli の full 再計算が絡むため重い。
  // 遅い CI ランナーでも収まるよう長めに取る。
  timeout: 300_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  // PoSW Worker が CPU を食うため無制限並列にはしないが、テスト時間の大半は
  // 打鍵待ち・sync 待ちの wall-clock なので 2 並列までは安全域 (CI ランナーは 4 vCPU)。
  // flake が再発したら 1 に戻す (その場合も spec の --mode fast 整合は維持する)。
  workers: 2,
  reporter: isCI ? [['list'], ['html', { open: 'never' }], ['github']] : [['list'], ['html', { open: 'never' }]],

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

  // `port:` は TCP 応答しか見ないため、既定ポートを別プロセスが握っていると
  // reuseExistingServer 時に「自分のサーバ」と誤認しうる (ローカル開発時のみ影響、
  // CI は reuseExistingServer: false)。起動コマンド自体にもポートを渡し、
  // E2E_EDITOR_PORT / E2E_WORKERS_PORT を指定したときに実際にそのポートで
  // 上がるようにする (指定しない限りは無指定と同じ既定ポートに上がる)。
  // 配線は scripts/dev.mjs (118-145 行目) と同じパターンを踏襲する。
  webServer: [
    {
      name: 'workers',
      // wrangler dev は env を読まないため、コマンド側に --port を渡す。
      command: `npm run dev -w @typedcode/workers -- --port ${WORKERS_PORT}`,
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
      // packages/editor/vite.config.ts が EDITOR_PORT (server.port + strictPort) と
      // WORKERS_PORT (VITE_API_URL 追従) を既に読む実装になっている。受け口は
      // 実装済みで、これまで渡していなかっただけなので env で渡す。
      // VERIFY_PORT は editor の `/verify` プロキシの向き先 (spec は verify を直接開くが、配線を揃えておく)。
      env: { EDITOR_PORT: String(EDITOR_PORT), WORKERS_PORT: String(WORKERS_PORT), VERIFY_PORT: String(VERIFY_PORT) },
      cwd: '../..',
      port: EDITOR_PORT,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      name: 'verify',
      command: 'npm run dev -w @typedcode/verify',
      // packages/verify/vite.config.ts は VERIFY_PORT があると server.port + strictPort にする
      // (別プロセスが握っていたら黙ってずらさず失敗する)。
      env: { VERIFY_PORT: String(VERIFY_PORT) },
      cwd: '../..',
      port: VERIFY_PORT,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
