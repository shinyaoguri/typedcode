import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WORKTREE_ID_HEADER, worktreeIdOf } from '../../scripts/worktree-id.mjs';

const isDev = process.env.NODE_ENV !== 'production';

// ビルド情報を取得
function getBuildInfo() {
  const rootPkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8'));
  let gitCommit = 'unknown';
  let gitCommitDate = '';
  try {
    gitCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
    gitCommitDate = execSync('git log -1 --format=%cI', { encoding: 'utf-8' }).trim();
  } catch {
    // Git not available
  }
  return {
    appVersion: rootPkg.version,
    gitCommit,
    gitCommitDate,
    buildDate: new Date().toISOString(),
  };
}

const buildInfo = getBuildInfo();

// dev ランチャー (scripts/dev.mjs) が割り当てたポート。個別起動時は未設定で既定
// (5174) にフォールバックする。
const verifyPort = Number(process.env.VERIFY_PORT) || 5174;

export default defineConfig({
  base: isDev ? '/' : '/verify/',
  server: {
    port: verifyPort,
    // ランチャー割当時 (VERIFY_PORT あり) は strictPort。editor の /verify プロキシが
    // このポート固定で追従するため、ずれると配線が壊れる。黙ってずらさず失敗させる。
    // 手動の個別起動 (VERIFY_PORT なし) は従来どおりフォールバック可。
    strictPort: Boolean(process.env.VERIFY_PORT),
    // この dev サーバがどの作業ツリーのものかを名乗る。e2e の globalSetup が照合し、別の worktree の
    // サーバを再利用しないようにする (#552)。dev サーバだけで、本番の配信には付けない。
    headers: {
      [WORKTREE_ID_HEADER]: worktreeIdOf(resolve(__dirname, '../..')),
    },
  },
  build: {
    target: 'esnext',
    minify: 'esbuild',
  },
  esbuild: {
    // 本番ビルド時のみconsole.logを削除
    drop: process.env.NODE_ENV === 'production' ? ['console', 'debugger'] : [],
  },
  define: {
    __APP_VERSION__: JSON.stringify(buildInfo.appVersion),
    __GIT_COMMIT__: JSON.stringify(buildInfo.gitCommit),
    __GIT_COMMIT_DATE__: JSON.stringify(buildInfo.gitCommitDate),
    __BUILD_DATE__: JSON.stringify(buildInfo.buildDate),
  },
});
