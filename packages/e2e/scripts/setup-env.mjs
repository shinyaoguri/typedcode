#!/usr/bin/env node
/**
 * E2E 用の環境を用意する (主に CI)。秘密情報は一切コミットせず、署名鍵は
 * 実行のたびに新規生成する。ローカルに既存の .dev.vars がある場合は何もしない
 * (開発者の skip-worktree な checkpoint 鍵 / Turnstile 設定を尊重する)。
 *
 * 用意するもの:
 *   - packages/workers/.dev.vars              … Turnstile テスト secret + 新規 checkpoint 署名鍵 (秘密 JWK)
 *   - packages/shared/src/checkpointKeys/localKeys.ts … 上記の公開鍵 (verifier が keyId 解決に使う)
 *   - packages/editor/.env                    … Turnstile テスト site key + ローカル Workers の API URL
 *
 * Cloudflare の Turnstile テストキー (公開・常に pass) を使うので Turnstile →
 * Workers 検証 → attestation 記録までフルスタックで回り、生成した checkpoint 鍵で
 * 署名チェックポイント (root anchoring) まで検証できる。
 */
import { webcrypto } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');

const DEV_VARS = resolve(ROOT, 'packages/workers/.dev.vars');
const LOCAL_KEYS = resolve(ROOT, 'packages/shared/src/checkpointKeys/localKeys.ts');
const EDITOR_ENV = resolve(ROOT, 'packages/editor/.env');

// Cloudflare Turnstile の公開テストキー (常に pass)。
const TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
const TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA';

if (existsSync(DEV_VARS)) {
  console.log('[e2e setup] packages/workers/.dev.vars exists — ローカル設定を尊重して何もしません');
  process.exit(0);
}

console.log('[e2e setup] .dev.vars が無いので E2E 用の環境を生成します (CI 想定)');

const { publicKey, privateKey } = await webcrypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify'],
);
const publicJwk = await webcrypto.subtle.exportKey('jwk', publicKey);
const privateJwk = await webcrypto.subtle.exportKey('jwk', privateKey);
// keyId は公開鍵 x 座標から決定的に作る (Date/乱数に依存しない)。
const keyId = `tcp-e2e-${(publicJwk.x ?? '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase()}`;

writeFileSync(
  DEV_VARS,
  [
    '# E2E 用に自動生成 (CI)。コミットしないこと。',
    `TURNSTILE_SECRET_KEY=${TURNSTILE_SECRET_KEY}`,
    'ATTESTATION_SECRET_KEY=e2e-attestation-secret',
    `CHECKPOINT_SIGNING_KEY_ID=${keyId}`,
    `CHECKPOINT_SIGNING_KEY_JWK=${JSON.stringify(privateJwk)}`,
    '',
  ].join('\n'),
);
console.log(`[e2e setup] .dev.vars を生成 (keyId=${keyId})`);

const publicEntry = {
  keyId,
  algorithm: 'ECDSA-P256',
  publicKeyJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y },
  status: 'active',
  validFrom: '2026-01-01T00:00:00.000Z',
  description: 'E2E test key (auto-generated, never used in production)',
};
writeFileSync(
  LOCAL_KEYS,
  [
    '// E2E 用に自動生成 (CI)。コミットしないこと。',
    "import type { CheckpointPublicKey } from './registry.js';",
    '',
    'export const LOCAL_CHECKPOINT_PUBLIC_KEYS: readonly CheckpointPublicKey[] = [',
    `  ${JSON.stringify(publicEntry)} as CheckpointPublicKey,`,
    '];',
    '',
  ].join('\n'),
);
console.log('[e2e setup] localKeys.ts に E2E 公開鍵を書き込み');

if (!existsSync(EDITOR_ENV)) {
  writeFileSync(
    EDITOR_ENV,
    [
      '# E2E 用に自動生成 (CI)。コミットしないこと。',
      `VITE_TURNSTILE_SITE_KEY=${TURNSTILE_SITE_KEY}`,
      'VITE_API_URL=http://localhost:8787',
      '',
    ].join('\n'),
  );
  console.log('[e2e setup] packages/editor/.env を生成');
} else {
  console.log('[e2e setup] packages/editor/.env は既存なので保持');
}

console.log('[e2e setup] 完了');
