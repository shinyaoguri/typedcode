#!/usr/bin/env node
/**
 * 試験問題パッケージ (`.tcexam`) 署名用の出題者 (exam authority) ECDSA-P256 鍵ペアを生成 (ADR-0006)。
 *
 * checkpointKeys の generate-checkpoint-key.mjs と同型だが用途・置き場が別系統:
 * - checkpointKeys = サーバが署名 cp に使う鍵
 * - examAuthorityKeys = 出題者が問題パッケージに使う鍵
 *
 * 出力:
 * - 私的 JWK (問題パッケージ署名ツール make-exam-package.mjs に渡す)
 * - 公開鍵 entry (ExamAuthorityKey 形式)
 * - 推奨 keyId
 *
 * 使い方:
 *   node packages/workers/scripts/generate-exam-authority-key.mjs > exam-key.txt
 *
 * 鍵の置き場所:
 * - **ローカル dev 鍵**: 公開鍵を packages/shared/src/examAuthorityKeys/localKeys.ts に
 *   append し、`git update-index --skip-worktree` で git status から隠す
 * - **本番運用鍵**: 公開鍵を packages/shared/src/examAuthorityKeys/registry.ts に
 *   append して PR レビュー、私的 JWK は出題者がオフラインで安全に保管
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
  const keyId = `exam-${yyyymm}-${random}`;
  const validFrom = new Date().toISOString();

  console.log('=== Recommended keyId ===');
  console.log(keyId);
  console.log('(学期を含めて exam-2026s-xxxxxx のように手で改名しても良い)');
  console.log('');
  console.log('=== validFrom (ISO) ===');
  console.log(validFrom);
  console.log('');
  console.log('=== Public key entry (ExamAuthorityKey) ===');
  console.log('For LOCAL dev: append to packages/shared/src/examAuthorityKeys/localKeys.ts');
  console.log('  then run: git update-index --skip-worktree packages/shared/src/examAuthorityKeys/localKeys.ts');
  console.log('For PRODUCTION: append to packages/shared/src/examAuthorityKeys/registry.ts and open a PR');
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
  console.log('=== Private JWK (DO NOT COMMIT) ===');
  console.log('問題パッケージ署名ツールに渡す (環境変数):');
  console.log('  EXAM_SIGNING_KEY_ID=' + keyId);
  console.log('  EXAM_SIGNING_KEY_JWK (single-line JSON):');
  console.log(JSON.stringify(privateJwk));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
