/**
 * e2e の dev サーバのポート。既定値は `npm run dev` の既定のセットと同じで、E2E_EDITOR_PORT /
 * E2E_VERIFY_PORT / E2E_WORKERS_PORT で上書きできる。playwright.config.ts (起動) と
 * global-setup.ts (どの作業ツリーのサーバかの照合。#552) が同じ値を読む。
 */
export const E2E_PORTS = {
  editor: Number(process.env.E2E_EDITOR_PORT ?? 5173),
  verify: Number(process.env.E2E_VERIFY_PORT ?? 5174),
  workers: Number(process.env.E2E_WORKERS_PORT ?? 8787),
} as const;
