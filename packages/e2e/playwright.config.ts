import { defineConfig, devices } from '@playwright/test';
import { E2E_PORTS } from './ports.js';

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

const { editor: EDITOR_PORT, workers: WORKERS_PORT, verify: VERIFY_PORT } = E2E_PORTS;
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${EDITOR_PORT}`;
const isCI = !!process.env.CI;

// verify Web の URL は helpers/verifyWeb.ts が読む。config は Playwright の worker プロセスでも
// 評価されるので、ここで env に置けば spec 側へポートの既定値を二重に書かずに済む。
process.env.E2E_VERIFY_URL ??= `http://localhost:${VERIFY_PORT}/`;

/** 通常の実行から外すタグ (`@shots` は SHOTS=1、`@nightly` は NIGHTLY=1、`@bench` は BENCH=1 のときだけ含める)。 */
function excludedTags(): RegExp | undefined {
  const tags = [
    ...(process.env.SHOTS === '1' ? [] : ['@shots']),
    ...(process.env.NIGHTLY === '1' ? [] : ['@nightly']),
    ...(process.env.BENCH === '1' ? [] : ['@bench']),
  ];
  return tags.length === 0 ? undefined : new RegExp(tags.join('|'));
}

export default defineConfig({
  testDir: './tests',
  // production-build.spec.ts は dist (vite preview) を対象にする専用 spec なので、
  // dev サーバ向けのこの設定からは外す。実行は playwright.build.config.ts
  // (`npm run test:build -w @typedcode/e2e`) が担う。
  testIgnore: /production-build\.spec\.ts$/,
  // 下の webServer がこの作業ツリーのサーバか (別の worktree のサーバを再利用していないか) を、
  // テストより前に照合する (#552)。Playwright は webServer の準備を globalSetup より先に済ませる。
  globalSetup: './global-setup.ts',
  // `@shots` は人が見る証跡を撮るだけで何も assert しない (tests/shots.spec.ts / ADR-0036)。
  // 検査ではないので通常の実行と CI のシャードからは外し、`npm run shots` (SHOTS=1) のときだけ走らせる。
  // `@nightly` は長い・ランダムな検査 (tests/model/ の model-based E2E 長尺 / #436) と、外部の配信物に依存する
  // C / Python の実行のスモーク (tests/code-execution-c-python.spec.ts / #589) で、PR ゲートには重い・不安定。
  // 通常の実行と CI のシャードからは外し、NIGHTLY=1 のときだけ含める (.github/workflows/e2e-nightly.yml)。
  // `@bench` は記録側 PoSW のベンチ (tests/posw.bench.spec.ts / ADR-0045)。数値を吐くだけで assert しないので、
  // 検査から外し、`npm run bench:posw` (BENCH=1) のときだけ走らせる。
  grepInvert: excludedTags(),
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
    // 1 つの操作・遷移の上限 (#584)。既定の 0 (上限なし) だと、止まった待ちはテスト全体の上限まで待ち、
    // 失敗もテストのタイムアウトとしか出ない。actionTimeout は context の既定 timeout になるので、click などの
    // 操作だけでなく、timeout を渡していない waitForFunction / waitForEvent / locator.waitFor もこの値で切れる。
    // 30 秒を超えて待つ箇所 (起動待ちの BOOT_TIMEOUT_MS など) は、その呼び出しに timeout を渡す。
    // expect の待ちは上の expect.timeout が決める。
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
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
  // CI は reuseExistingServer: false)。別の worktree の本物の editor / workers / verify が
  // 握っている場合は globalSetup (global-setup.ts) が作業ツリーの識別子を照合して落とす (#552)。
  // 起動コマンド自体にもポートを渡し、E2E_EDITOR_PORT / E2E_WORKERS_PORT を指定したときに
  // 実際にそのポートで上がるようにする (指定しない限りは無指定と同じ既定ポートに上がる)。
  // 配線は scripts/dev.mjs (「起動」の節、120-147 行目) と同じパターンを踏襲する。
  webServer: [
    {
      name: 'workers',
      // wrangler dev は env を読まないため、コマンド側に --port を渡す。作業ツリーの識別子
      // (--var DEV_WORKTREE_ID) は packages/workers の dev スクリプト自体が渡す (#552)。
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
      // exam の出題者鍵だけ E2E 用に差し替える設定で起こす (開発者の鍵置き場 localKeys.ts は書き換えない。#229)。
      command: 'npm run dev -w @typedcode/editor -- --config ../e2e/vite.editor.config.mjs',
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
