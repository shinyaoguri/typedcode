/**
 * verify-cli を単一の ESM ファイル `dist/cli.js` に bundle する (#298)。
 *
 *   node scripts/build.mjs           # build (package.json の `build` は先に tsc --noEmit で型検査する)
 *   node scripts/build.mjs --watch   # watch モード (`npm run dev`)
 *
 * なぜ tsc の出力ではなく bundle か: `@typedcode/shared` の main / exports は raw TypeScript
 * (`src/index.ts`) で、中の import は `.js` 拡張子 (bundler 解決前提)。tsc の出力を素の node で
 * 起動すると shared の解決で ERR_MODULE_NOT_FOUND になる (Node のバージョンとは無関係)。
 * shared を JS + d.ts 生成に変える案は editor / verify / workers の Vite 解決と PoSW Worker の
 * URL 解決に波及するので採らず、CLI 側で shared ごと 1 ファイルに取り込む。
 *
 * `--analyzer <module>` の外部モジュールは実行時の動的 import (パスは引数で決まる) なので
 * bundle には入らず、そのまま Node が読み込む。
 */

import { chmodSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = `${PACKAGE_ROOT}dist`;
const OUT_FILE = `${OUT_DIR}/cli.js`;
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  absWorkingDir: PACKAGE_ROOT,
  entryPoints: ['src/cli.ts'],
  outfile: OUT_FILE,
  bundle: true,
  platform: 'node',
  format: 'esm',
  // engines (>=24) と揃える
  target: 'node24',
  // ESM bundle には `require` が無い。CJS 依存 (jszip 等) が Node builtin を動的 `require` した
  // 時点で "Dynamic require of ... is not supported" になる既知の罠を、createRequire で塞ぐ。
  // 現状の依存はこれ無しでも動くが、依存更新で黙って壊れないための防御。
  // (src/cli.ts 先頭の shebang は esbuild がこの banner より前に保持する)
  banner: {
    js: "import { createRequire as __tcCreateRequire } from 'node:module'; const require = __tcCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
};

// tsc 時代の出力 (analyzers.js / *.d.ts 等) が残ると `files: ["dist"]` で配布物に混ざるので毎回消す
rmSync(OUT_DIR, { recursive: true, force: true });

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
  // bin として直接実行できるように (npm install 時にも付くが、リポジトリ内での `./dist/cli.js` 用)
  chmodSync(OUT_FILE, 0o755);
}
