/**
 * build 設定 (playwright.build.config.ts / `npm run test:build`) の照合 (#560)。
 *
 * 照合するのは workers の 1 台だけ。editor-preview は `reuseExistingServer: false` で毎回この作業ツリーの dist を
 * build して起こすので、別の作業ツリーのサーバを再利用することがない (ポートが埋まっていれば Playwright が起動前に落とす)。
 * 判定と throw は global-setup.ts の checkIdentities と同じで、再実行例だけ build 用のコマンドにする。
 */
import { checkIdentities } from './global-setup.js';
import { E2E_PORTS } from './ports.js';

export default async function globalSetup(): Promise<void> {
  await checkIdentities([{ name: 'workers', envVar: 'E2E_WORKERS_PORT', port: E2E_PORTS.workers, probe: 'health' }], {
    rerun: 'npm run test:build -w @typedcode/e2e',
  });
}
