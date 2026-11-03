#!/usr/bin/env node
/**
 * dev 用の公開鍵置き場 `localKeys.ts` (checkpoint 鍵と出題者鍵の 2 つ) を、無ければ隣の
 * `localKeys.ts.example` から作る (#338)。
 *
 * `localKeys.ts` は gitignore 済みで git が持たないので、clean な checkout や新しい worktree には無い。
 * shared の `index.ts` が `./localKeys.js` を import しているので、無いと typecheck / build / テストが
 * 解決に失敗する。そこで次の 3 か所から呼ぶ:
 *   - ルートの `postinstall` (`npm install` / CI の `npm ci`)
 *   - e2e の setup (`packages/e2e/scripts/setup-env.mjs`。`npm install` を通らない worktree 向け)
 *   - `npm run doctor`
 *
 * **既にあるファイルは絶対に上書きしない** (開発者が自分の dev 鍵を置いている)。`COPYFILE_EXCL` で
 * 「無ければ作る」を 1 回の操作にしているので、確認と書き込みの間に作られても上書きしない。
 *
 * 使い方: `node scripts/ensure-local-keys.mjs` (`.example` が無いなどで作れなければ非 0 で終わる)
 */

import { constants, copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 作る対象 (ルートからの相対パス)。`.example` はそれぞれの隣に置く。 */
export const LOCAL_KEYS_FILES = [
  'packages/shared/src/checkpointKeys/localKeys.ts',
  'packages/shared/src/examAuthorityKeys/localKeys.ts',
];

/**
 * `LOCAL_KEYS_FILES` のうち存在しないものだけを `.example` からコピーする。
 * 戻り値は作ったファイルの (ルートからの) 相対パスの配列。`.example` が無ければ throw する。
 * @param {{ root?: string, log?: (msg: string) => void }} [options]
 * @returns {string[]}
 */
export function ensureLocalKeys({ root = ROOT, log = console.log } = {}) {
  const created = [];
  for (const rel of LOCAL_KEYS_FILES) {
    const target = resolve(root, rel);
    if (existsSync(target)) continue;
    try {
      copyFileSync(`${target}.example`, target, constants.COPYFILE_EXCL);
    } catch (err) {
      // 確認の後に別のプロセスが作った: 上書きせずにそのまま使う
      if (err?.code === 'EEXIST') continue;
      throw err;
    }
    created.push(rel);
    log(`[local-keys] ${rel} を ${rel}.example から作りました (gitignore 済み。#338)`);
  }
  return created;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    ensureLocalKeys();
  } catch (err) {
    console.error(`[local-keys] localKeys.ts を作れませんでした: ${err?.message ?? err}`);
    process.exitCode = 1;
  }
}
