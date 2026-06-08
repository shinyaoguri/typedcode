import { defineConfig } from 'vite';
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
    port: 5173,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    proxy: {
      '/verify': {
        target: 'http://localhost:5174',
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
    exclude: ['@wasmer/sdk']
  }
});
