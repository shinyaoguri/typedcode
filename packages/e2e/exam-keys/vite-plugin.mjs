/**
 * editor の dev サーバ (vite.editor.config.mjs) が使う Vite プラグイン (#229)。
 *
 * shared の `examAuthorityKeys/index.ts` が読む `./localKeys` を、E2E の出題者「公開」鍵
 * (fixtures/exam/authority-keys.mjs。setup-exam-fixture.mjs が生成) に差し替える。
 * 追跡ファイル `localKeys.ts` を書き換えずに、E2E の使い捨て鍵を信頼させるための仕組み。
 *
 * fixture が無ければ何もしない (通常の localKeys.ts がそのまま使われる)。dev サーバ専用で、
 * 本番ビルドの設定 (packages/editor/vite.config.ts) には入っていない。
 */
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 差し替え先 (setup-exam-fixture.mjs が書く)。 */
export const AUTHORITY_KEYS_MODULE = resolve(HERE, '../fixtures/exam/authority-keys.mjs');

/** `examAuthorityKeys/index.ts` から `./localKeys` を読む import か。 */
export function isExamLocalKeysImport(specifier, importer) {
  return (
    /^\.\/localKeys\.(js|ts)$/.test(specifier) && /[\\/]examAuthorityKeys[\\/]index\.(js|ts)$/.test(importer ?? '')
  );
}

export function examAuthorityKeysPlugin() {
  return {
    name: 'e2e-exam-authority-keys',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!existsSync(AUTHORITY_KEYS_MODULE)) return null;
      return isExamLocalKeysImport(source, importer) ? AUTHORITY_KEYS_MODULE : null;
    },
  };
}
