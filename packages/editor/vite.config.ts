import { defineConfig, loadEnv, type Plugin } from 'vite';
import wasm from 'vite-plugin-wasm';
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

// @wasmer/sdk (0.19 以降) は worker と、worker が動的 import する SDK 本体 (wasm-bindgen の glue) を
// `new URL('./browser-worker.js', import.meta.url)` / `new URL('../pkg/wasmer_sdk_js.js', import.meta.url)`
// で自分で解決する。本番ビルドの Vite はこれを「中身を触らない静的アセット」としてコピーするので、
// そのファイルが持つ相対 import (`./node-compat.js` や `./snippets/.../inline0.js`) が dist に
// 存在せず、worker の起動で 404 になる。ビルド時だけこの 2 か所を、依存をバンドルしたチャンクの
// URL に置き換える (#364):
// - worker は `?worker&url` (自己完結した worker チャンク。export は要らない)
// - SDK 本体は worker が `default` と `ThreadPoolWorker` を import して使うので、export を残す
//   必要がある。`?worker&url` は export を落とすため、`preserveSignature` 付きのチャンクとして
//   emit して `import.meta.ROLLUP_FILE_URL_*` で参照する
// dev サーバは node_modules をそのまま配信して相対 import が解決するので触らない。
const WASMER_SDK_WORKER_EXPR = 'new URL("./browser-worker.js", import.meta.url)';
const WASMER_SDK_GLUE_EXPR = 'new URL("../pkg/wasmer_sdk_js.js", import.meta.url)';

function wasmerSdkBundledWorkers(): Plugin {
  return {
    name: 'wasmer-sdk-bundled-workers',
    apply: 'build',
    enforce: 'pre',
    async transform(code, id) {
      if (!/[\\/]@wasmer[\\/]sdk[\\/]dist[\\/]index\.js$/.test(id)) return null;
      for (const expr of [WASMER_SDK_WORKER_EXPR, WASMER_SDK_GLUE_EXPR]) {
        if (!code.includes(expr)) {
          // SDK の更新で書き方が変わったら、壊れた worker を黙って出さずにビルドを止める
          throw new Error(`[wasmer-sdk-bundled-workers] pattern not found in @wasmer/sdk: ${expr}`);
        }
      }
      const glue = await this.resolve('../pkg/wasmer_sdk_js.js', id);
      if (!glue) throw new Error('[wasmer-sdk-bundled-workers] cannot resolve @wasmer/sdk glue module');
      const ref = this.emitFile({ type: 'chunk', id: glue.id, preserveSignature: 'strict' });
      const out = code
        .replace(WASMER_SDK_WORKER_EXPR, 'new URL(__wasmerSdkWorkerUrl, import.meta.url)')
        .replace(WASMER_SDK_GLUE_EXPR, `new URL(import.meta.ROLLUP_FILE_URL_${ref}, import.meta.url)`);
      return { code: `import __wasmerSdkWorkerUrl from "./browser-worker.js?worker&url";\n${out}`, map: null };
    },
  };
}

export default defineConfig({
  plugins: [
    wasm(),
    wasmerSdkBundledWorkers(),
    // vite-plugin-top-level-await は使わない (#255)。このプラグインは
    // チャンクの全エクスポートを先頭の let へ巻き上げて本体を async IIFE で包むため、
    // 関数宣言の巻き上げに依存している monaco (vs/platform/instantiation) が壊れ、
    // 本番ビルドのエディタが起動しなくなる。build.target: 'esnext' と
    // worker.format: 'es' でネイティブ TLA が使えるので、そもそも不要。
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
  resolve: {
    alias: {
      // @wasmer/sdk の WISP ネットワーク (network mode "wisp" 専用) が読む AGPL-3.0 の
      // wisp-js を、配信物に入れないためローカルの空実装に差し替える。sandbox の
      // ネットワークは使わない (#364)
      '@mercuryworkshop/wisp-js/client': resolve(__dirname, 'src/executors/c/wispClientStub.ts'),
    },
  },
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
    // preview.proxy は未指定だと server.proxy を引き継ぎ、`/verify` を dev の verify サーバへ
    // 転送してしまう (起動していなければ 502)。preview は dist の配信なので、deploy と同じく
    // dist の `verify/` (e2e の playwright.build.config.ts が重ねる) をそのまま返す。
    proxy: {},
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
