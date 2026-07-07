#!/usr/bin/env node
/**
 * Signed checkpoint 署名用 ECDSA-P256 鍵ペアを生成。
 *
 * 出力:
 * - 私的 JWK (Worker 環境変数 CHECKPOINT_SIGNING_KEY_JWK 用)
 * - 公開鍵 entry (CheckpointPublicKey 形式)
 * - 推奨 keyId
 *
 * 使い方:
 *   node packages/workers/scripts/generate-checkpoint-key.mjs > new-key.txt
 *
 * 鍵の置き場所:
 * - **ローカル dev 鍵**: 公開鍵を packages/shared/src/checkpointKeys/localKeys.ts に
 *   append し、`git update-index --skip-worktree` で git status から隠す
 * - **本番運用鍵**: 公開鍵を packages/shared/src/checkpointKeys/registry.ts に
 *   append して PR レビュー、私的 JWK は `wrangler secret put` で本番に投入
 */

import { webcrypto } from 'node:crypto';

async function main() {
  const { publicKey, privateKey } = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);

  const publicJwk = await webcrypto.subtle.exportKey('jwk', publicKey);
  const privateJwk = await webcrypto.subtle.exportKey('jwk', privateKey);

  const yyyymm = new Date().toISOString().slice(0, 7).replace('-', '');
  const random = Math.random().toString(16).slice(2, 8);
  const keyId = `tcp-${yyyymm}-${random}`;
  const validFrom = new Date().toISOString();

  console.log('=== Recommended keyId ===');
  console.log(keyId);
  console.log('');
  console.log('=== validFrom (ISO) ===');
  console.log(validFrom);
  console.log('');
  console.log('=== Public key entry ===');
  console.log('For LOCAL dev: append to packages/shared/src/checkpointKeys/localKeys.ts');
  console.log('  then run: git update-index --skip-worktree packages/shared/src/checkpointKeys/localKeys.ts');
  console.log('For PRODUCTION: append to packages/shared/src/checkpointKeys/registry.ts and open a PR');
  console.log('');
  console.log(
    JSON.stringify(
      {
        keyId,
        algorithm: 'ECDSA-P256',
        publicKeyJwk: publicJwk,
        status: 'active',
        validFrom,
      },
      null,
      2
    )
  );
  console.log('');
  console.log('=== Wrangler secrets (DO NOT COMMIT) ===');
  console.log('For LOCAL dev: paste into packages/workers/.dev.vars');
  console.log(
    'For PRODUCTION: `wrangler secret put CHECKPOINT_SIGNING_KEY_ID` and `wrangler secret put CHECKPOINT_SIGNING_KEY_JWK`'
  );
  console.log('');
  console.log('CHECKPOINT_SIGNING_KEY_ID:');
  console.log(keyId);
  console.log('');
  console.log('CHECKPOINT_SIGNING_KEY_JWK (single-line JSON):');
  console.log(JSON.stringify(privateJwk));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
