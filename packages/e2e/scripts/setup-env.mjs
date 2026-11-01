#!/usr/bin/env node
/**
 * E2E 用の環境を用意する (主に CI)。秘密情報は一切コミットせず、署名鍵は
 * 実行のたびに新規生成する。ローカルに既存の .dev.vars がある場合は生成しない
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
 *
 * 既存の .dev.vars がある場合は、その CHECKPOINT_SIGNING_KEY_ID が registry.ts か
 * localKeys.ts に載っているかだけを確かめる (#388)。localKeys.ts は追跡ファイルなので
 * checkout で空配列に戻ることがあり (#338)、そのままでは workers が SIGNING_KEY_UNKNOWN で
 * /api/session/start を 500 にし、e2e が「署名 0 件」で分かりにくく落ちる。
 * 開発者の .dev.vars は上書きせず、直し方を出して非 0 で終える。秘密 JWK の行は読まない。
 */
import { webcrypto } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');

// Cloudflare Turnstile の公開テストキー (常に pass)。
const TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
const TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA';

/**
 * .dev.vars の本文から CHECKPOINT_SIGNING_KEY_ID の値だけを取り出す。無い・空なら null。
 * 他の行 (秘密 JWK を含む) は値を保持しない。
 */
export function readSigningKeyId(devVarsText) {
  for (const line of devVarsText.split(/\r?\n/)) {
    const match = /^\s*CHECKPOINT_SIGNING_KEY_ID\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    return value === '' ? null : value;
  }
  return null;
}

/** keyId が registry / localKeys のソースのどれかに、引用符付きの文字列として現れるか。 */
export function isKeyIdRegistered(keyId, sourceTexts) {
  return sourceTexts.some((text) => text.includes(`'${keyId}'`) || text.includes(`"${keyId}"`));
}

/**
 * E2E 用の環境を root 配下に用意する。戻り値は終了コード。
 * @param {{ root?: string, log?: (msg: string) => void, error?: (msg: string) => void }} [options]
 */
export async function setupEnv({ root = ROOT, log = console.log, error = console.error } = {}) {
  const devVars = resolve(root, 'packages/workers/.dev.vars');
  const registryTs = resolve(root, 'packages/shared/src/checkpointKeys/registry.ts');
  const localKeys = resolve(root, 'packages/shared/src/checkpointKeys/localKeys.ts');
  const editorEnv = resolve(root, 'packages/editor/.env');

  if (existsSync(devVars)) {
    const keyId = readSigningKeyId(readFileSync(devVars, 'utf8'));
    const sources = [registryTs, localKeys]
      .filter((file) => existsSync(file))
      .map((file) => readFileSync(file, 'utf8'));
    if (keyId && isKeyIdRegistered(keyId, sources)) {
      log('[e2e setup] packages/workers/.dev.vars exists — ローカル設定を尊重して何もしません');
      return 0;
    }
    error(
      [
        keyId
          ? `[e2e setup] .dev.vars の CHECKPOINT_SIGNING_KEY_ID (${keyId}) が registry.ts にも localKeys.ts にもありません。`
          : '[e2e setup] .dev.vars に CHECKPOINT_SIGNING_KEY_ID がありません。',
        '  このままでは workers が署名を拒否し (SIGNING_KEY_UNKNOWN / SIGNING_KEY_NOT_CONFIGURED)、e2e は署名 0 件で落ちます。',
        '  直し方 (どちらか):',
        '    - e2e 用の使い捨て鍵なら、.dev.vars を退避して setup を再実行する:',
        '        mv packages/workers/.dev.vars packages/workers/.dev.vars.bak && npm run setup -w @typedcode/e2e',
        '      (退避したファイルは gitignore されないので、確認後に削除する)',
        '    - 自分の dev 鍵なら、その公開鍵を packages/shared/src/checkpointKeys/localKeys.ts に戻す (#338)',
      ].join('\n')
    );
    return 1;
  }

  log('[e2e setup] .dev.vars が無いので E2E 用の環境を生成します (CI 想定)');

  const { publicKey, privateKey } = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const publicJwk = await webcrypto.subtle.exportKey('jwk', publicKey);
  const privateJwk = await webcrypto.subtle.exportKey('jwk', privateKey);
  // keyId は公開鍵 x 座標から決定的に作る (Date/乱数に依存しない)。
  const keyId = `tcp-e2e-${(publicJwk.x ?? '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 8)
    .toLowerCase()}`;

  writeFileSync(
    devVars,
    [
      '# E2E 用に自動生成 (CI)。コミットしないこと。',
      `TURNSTILE_SECRET_KEY=${TURNSTILE_SECRET_KEY}`,
      'ATTESTATION_SECRET_KEY=e2e-attestation-secret',
      `CHECKPOINT_SIGNING_KEY_ID=${keyId}`,
      `CHECKPOINT_SIGNING_KEY_JWK=${JSON.stringify(privateJwk)}`,
      '',
    ].join('\n')
  );
  log(`[e2e setup] .dev.vars を生成 (keyId=${keyId})`);

  const publicEntry = {
    keyId,
    algorithm: 'ECDSA-P256',
    publicKeyJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y },
    status: 'active',
    validFrom: '2026-01-01T00:00:00.000Z',
    description: 'E2E test key (auto-generated, never used in production)',
  };
  writeFileSync(
    localKeys,
    [
      '// E2E 用に自動生成 (CI)。コミットしないこと。',
      "import type { CheckpointPublicKey } from './registry.js';",
      '',
      'export const LOCAL_CHECKPOINT_PUBLIC_KEYS: readonly CheckpointPublicKey[] = [',
      `  ${JSON.stringify(publicEntry)} as CheckpointPublicKey,`,
      '];',
      '',
    ].join('\n')
  );
  log('[e2e setup] localKeys.ts に E2E 公開鍵を書き込み');

  if (!existsSync(editorEnv)) {
    writeFileSync(
      editorEnv,
      [
        '# E2E 用に自動生成 (CI)。コミットしないこと。',
        `VITE_TURNSTILE_SITE_KEY=${TURNSTILE_SITE_KEY}`,
        'VITE_API_URL=http://localhost:8787',
        '',
      ].join('\n')
    );
    log('[e2e setup] packages/editor/.env を生成');
  } else {
    log('[e2e setup] packages/editor/.env は既存なので保持');
  }

  log('[e2e setup] 完了');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await setupEnv();
}
