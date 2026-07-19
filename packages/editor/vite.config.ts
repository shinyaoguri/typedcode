import { defineConfig, loadEnv } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

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

// dev ランチャー (scripts/dev.mjs) が割り当てたポート。個別起動時は未設定で、
// その場合は既定 (5173/5174) にフォールバックする。verifyPort は /verify プロキシの
// 追従先。
const editorPort = Number(process.env.EDITOR_PORT) || 5173;
const verifyPort = Number(process.env.VERIFY_PORT) || 5174;

// ランチャー (scripts/dev.mjs) がポート割当した場合、.env の VITE_API_URL が
// ローカル既定 (http://localhost:<port>) のままなら実際の workers ポートへ追従させる。
// staging 等の外部 URL を明示している場合は触らない。
// (Vite は process.env に既にある変数を .env ファイルより優先する)
const workersPort = process.env.WORKERS_PORT;
if (workersPort) {
  const fileEnv = loadEnv('development', __dirname, '');
  const current = process.env.VITE_API_URL ?? fileEnv.VITE_API_URL;
  if (!current || /^https?:\/\/(localhost|127\.0\.0\.1):\d+\/?$/.test(current)) {
    process.env.VITE_API_URL = `http://localhost:${workersPort}`;
  }
}

export default defineConfig({
  plugins: [
    wasm(),
    topLevelAwait(),
    // dev サーバで `/author` (拡張子なし) を `/author.html` に解決する。
    // 本番 (Cloudflare Pages) は clean URL で `/author` → `author.html` を自動配信するため不要。
    {
      name: 'author-clean-url',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === '/author' || req.url === '/author/') {
            req.url = '/author.html';
          }
          next();
        });
      },
    },
  ],
  base: '/',
  worker: {
    format: 'es',
  },
  server: {
    port: editorPort,
    // ランチャー割当時 (EDITOR_PORT あり) は strictPort で「ずれたら失敗」にする。
    // ポートがずれると /verify プロキシ (verifyPort 固定) や VITE_API_URL の配線が
    // 別プロセスを指してしまうため、黙ってずらさず即エラーにして気付かせる。
    // 手動の個別起動 (EDITOR_PORT なし) は従来どおり vite のフォールバックに任せる。
    strictPort: Boolean(process.env.EDITOR_PORT),
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    proxy: {
      '/verify': {
        target: `http://localhost:${verifyPort}`,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/verify/, ''),
      },
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  build: {
    target: 'esnext',
    minify: 'esbuild',
    rollupOptions: {
      // マルチページ: 編集アプリ (index.html) と出題者ツール (author.html) を別エントリで出力。
      // author.html は Monaco を読まない軽量ページ。
      input: {
        main: resolve(__dirname, 'index.html'),
        author: resolve(__dirname, 'author.html'),
      },
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(buildInfo.appVersion),
    __GIT_COMMIT__: JSON.stringify(buildInfo.gitCommit),
    __GIT_COMMIT_DATE__: JSON.stringify(buildInfo.gitCommitDate),
    __BUILD_DATE__: JSON.stringify(buildInfo.buildDate),
  },
  esbuild: {
    // 本番ビルド時のみconsole.logを削除
    drop: process.env.NODE_ENV === 'production' ? ['console', 'debugger'] : [],
  },
  optimizeDeps: {
    exclude: ['@wasmer/sdk'],
  },
});
