import { defineConfig, devices } from '@playwright/test';
import { E2E_BROWSER_ENV } from './browser-env.js';

/**
 * Python runner 隔離の PoC (#719 / #650) 専用の Playwright 設定。検査ではなく計測 (spike) で、
 * 通常の e2e・CI からは走らない (testDir が spike/ なので playwright.config.ts の対象外)。
 *
 * 実行: npx playwright test -c playwright.spike.config.ts (packages/e2e で)
 *
 * project ごとに親の origin を変える:
 * - static-prod-headers: 本番と同じヘッダ (public/_headers) を返す小さな静的サーバ (spike/python-runner/server.mjs)
 * - editor-dev: editor の vite dev サーバ (/author.html。editor と同じ origin)
 * - editor-preview: editor の本番ビルドを vite preview で配る (/author.html)
 */
const PORT = {
  parent: Number(process.env.SPIKE_PARENT_PORT ?? 5391),
  runner: Number(process.env.SPIKE_RUNNER_PORT ?? 5392),
  dev: Number(process.env.SPIKE_DEV_PORT ?? 5393),
  preview: Number(process.env.SPIKE_PREVIEW_PORT ?? 5394),
};
process.env.SPIKE_RUNNER_ORIGIN ??= `http://127.0.0.1:${PORT.runner}`;

const only = process.env.SPIKE_PROJECTS?.split(',');
const projects = [
  { name: 'static-prod-headers', baseURL: `http://localhost:${PORT.parent}/` },
  { name: 'editor-dev', baseURL: `http://localhost:${PORT.dev}/author.html` },
  { name: 'editor-preview', baseURL: `http://localhost:${PORT.preview}/author.html` },
].filter((p) => !only || only.includes(p.name));

export default defineConfig({
  testDir: './spike',
  timeout: 300_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: { ...E2E_BROWSER_ENV, trace: 'off', actionTimeout: 30_000 },
  // SPIKE_CHANNEL=chromium で headless shell でなく本体の Chromium (new headless) を使う (OOPIF の判定用)
  projects: projects.map((p) => ({
    name: p.name,
    use: { ...devices['Desktop Chrome'], baseURL: p.baseURL, channel: process.env.SPIKE_CHANNEL },
  })),
  webServer: [
    {
      command: `node spike/python-runner/server.mjs ${PORT.parent} ${PORT.runner}`,
      port: PORT.parent,
      reuseExistingServer: false,
    },
    ...(projects.some((p) => p.name === 'editor-dev')
      ? [
          {
            command: `npm run dev -w @typedcode/editor -- --port ${PORT.dev} --strictPort`,
            cwd: '../..',
            port: PORT.dev,
            reuseExistingServer: false,
            timeout: 120_000,
          },
        ]
      : []),
    ...(projects.some((p) => p.name === 'editor-preview')
      ? [
          {
            command: `npm run build -w @typedcode/editor && npm run preview -w @typedcode/editor -- --port ${PORT.preview} --strictPort`,
            cwd: '../..',
            port: PORT.preview,
            reuseExistingServer: false,
            timeout: 300_000,
          },
        ]
      : []),
  ],
});
