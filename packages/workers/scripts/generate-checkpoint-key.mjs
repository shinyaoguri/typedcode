#!/usr/bin/env node
/**
 * Signed checkpoint 署名用 ECDSA-P256 鍵ペアを生成。
 *
 * 出力:
 * - 私的 JWK (Worker 環境変数 CHECKPOINT_SIGNING_KEY_JWK 用)
 * - 公開 JWK (packages/shared/src/checkpointKeys/registry.ts に append 用)
 * - 推奨 keyId
 *
 * 使い方:
 *   node packages/workers/scripts/generate-checkpoint-key.mjs > new-key.txt
 *
 * 注: このスクリプト自体は Cloudflare KV や Workers と通信しない。
 * 鍵を発行したら:
 * 1) 公開鍵を registry.ts に append (status:'active', validFrom: now)
 * 2) 私的 JWK を `wrangler secret put CHECKPOINT_SIGNING_KEY_JWK` で投入
 * 3) keyId を `wrangler secret put CHECKPOINT_SIGNING_KEY_ID` で投入
 */

import { webcrypto } from 'node:crypto';

async function main() {
  const { publicKey, privateKey } = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );

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
  console.log('=== Append to packages/shared/src/checkpointKeys/registry.ts ===');
  console.log(JSON.stringify(
    {
      keyId,
      algorithm: 'ECDSA-P256',
      publicKeyJwk: publicJwk,
      status: 'active',
      validFrom,
    },
    null,
    2
  ));
  console.log('');
  console.log('=== Wrangler secrets (DO NOT COMMIT) ===');
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
