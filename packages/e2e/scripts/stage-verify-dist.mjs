#!/usr/bin/env node
/**
 * verify の本番ビルド (`packages/verify/dist`) を editor の dist の `verify/` へ置く。
 *
 * deploy.yml の「Merge build outputs」(editor の dist を土台に `dist/verify` として verify を
 * 重ねる) と同じ配置を `vite preview` で再現するため (playwright.build.config.ts から呼ぶ)。
 * verify は `base: '/verify/'` でビルドされるので、この配置でしか本番と同じ URL で動かない。
 *
 * 書き込み先は gitignore 済みのビルド出力だけ。前回の残骸が混ざらないよう先に消す。
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const src = resolve(ROOT, 'packages/verify/dist');
const editorDist = resolve(ROOT, 'packages/editor/dist');
const dest = resolve(editorDist, 'verify');

for (const [label, path] of [
  ['verify dist', src],
  ['editor dist', editorDist],
]) {
  if (!existsSync(path)) {
    console.error(`[stage-verify-dist] ${label} がありません (${path})。先に build してください`);
    process.exit(1);
  }
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`[stage-verify-dist] ${src} -> ${dest}`);
