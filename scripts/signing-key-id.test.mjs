/**
 * scripts/signing-key-id.mjs (doctor と e2e setup が共有する署名鍵 ID の判定 / #388, #827) の検証。
 *
 * 実行: `node --test scripts/signing-key-id.test.mjs`
 * (`npm run check:fast` と check job の `node --test 'scripts/*.test.mjs'` に自動で乗る)。
 * ファイルは読まず、中身の文字列を渡して判定だけを見る。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { judgeSigningKeyId } from './signing-key-id.mjs';

const noPlaceholder = { isPlaceholder: () => false };
const REGISTRY = "export const keys = [{ keyId: 'tcp-202605-fd6d42', algorithm: 'ECDSA-P256' }];";

/** setup-env.mjs が書く形 (entry を JSON.stringify するのでキーも引用符付き)。 */
function setupEnvLocalKeys(keyId) {
  return [
    "import type { LocalCheckpointPublicKey } from './registry.js';",
    'export const LOCAL_CHECKPOINT_PUBLIC_KEYS: readonly LocalCheckpointPublicKey[] = [',
    `  ${JSON.stringify({ keyId, algorithm: 'ECDSA-P256', status: 'active' })} as LocalCheckpointPublicKey,`,
    '];',
  ].join('\n');
}

/** gen-checkpoint-key の出力を貼った形 (キーに引用符が無い)。 */
function genKeyLocalKeys(keyId) {
  return `export const LOCAL_CHECKPOINT_PUBLIC_KEYS = [\n  { keyId: '${keyId}', status: 'active' },\n];`;
}

function devVarsWith(keyId) {
  return `TURNSTILE_SECRET_KEY=x\nCHECKPOINT_SIGNING_KEY_ID=${keyId}\nCHECKPOINT_SIGNING_KEY_JWK={}\n`;
}

describe('judgeSigningKeyId', () => {
  it('does not fail when .dev.vars names a keyId that setup-env wrote to localKeys.ts as JSON', () => {
    const result = judgeSigningKeyId(
      { devVars: devVarsWith('tcp-e2e-abc'), registry: REGISTRY, localKeys: setupEnvLocalKeys('tcp-e2e-abc') },
      noPlaceholder
    );
    assert.equal(result.status, 'ok');
  });

  it('fails when localKeys.ts holds only a different tcp- entry than the .dev.vars keyId', () => {
    const result = judgeSigningKeyId(
      { devVars: devVarsWith('tcp-e2e-abc'), registry: REGISTRY, localKeys: genKeyLocalKeys('tcp-e2e-other') },
      noPlaceholder
    );
    assert.equal(result.status, 'fail');
  });

  it('accepts a matching entry written with an unquoted keyId property by gen-checkpoint-key', () => {
    const result = judgeSigningKeyId(
      { devVars: devVarsWith('tcp-dev-1a2b3c'), registry: REGISTRY, localKeys: genKeyLocalKeys('tcp-dev-1a2b3c') },
      noPlaceholder
    );
    assert.equal(result.status, 'ok');
  });

  it('does not treat a keyId as present when only a longer keyId containing it is registered', () => {
    const result = judgeSigningKeyId(
      { devVars: devVarsWith('tcp-e2e-abc'), registry: REGISTRY, localKeys: setupEnvLocalKeys('tcp-e2e-abcd') },
      noPlaceholder
    );
    assert.equal(result.status, 'fail');
  });
});
