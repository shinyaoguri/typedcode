/**
 * verify-cli (tsx) 用の module resolve フック (#229)。vite-plugin.mjs の Node 版。
 *
 * shared の `examAuthorityKeys/index.ts` が読む `./localKeys` を、E2E の出題者公開鍵
 * (fixtures/exam/authority-keys.mjs) に差し替える。開発者の鍵置き場 `localKeys.ts` (gitignore 済み) は書き換えない。
 * node-register.mjs が登録する。fixture が無ければ何もしない。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AUTHORITY_KEYS_MODULE, isExamLocalKeysImport } from './vite-plugin.mjs';

export async function resolve(specifier, context, nextResolve) {
  const importer = context.parentURL?.startsWith('file:') ? fileURLToPath(context.parentURL) : undefined;
  if (existsSync(AUTHORITY_KEYS_MODULE) && isExamLocalKeysImport(specifier, importer)) {
    return { url: pathToFileURL(AUTHORITY_KEYS_MODULE).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
