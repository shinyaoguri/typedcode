/**
 * 出題者 (exam authority) 署名鍵の生成ヘルパ (ADR-0006)。
 *
 * `packages/workers/scripts/generate-exam-authority-key.mjs` のブラウザ版。教員が CLI を
 * 触らずに ECDSA-P256 鍵ペアを発行し、私的 JWK をローカル保管・公開鍵 entry を registry 登録
 * 依頼へ回せるようにする。鍵は **registry が信頼アンカー** (append-only) なので、公開鍵 entry は
 * 別途 PR で `examAuthorityKeys/{registry,localKeys}.ts` に追記する運用は変わらない。
 *
 * DOM 非依存・WebCrypto のみ依存。`suggestKeyId` は純関数で時刻/乱数を注入でき、テスト可能。
 */

import type { ExamAuthorityKey } from '@typedcode/shared';

/**
 * keyId を `exam-YYYYMM-xxxxxx` 規約で組み立てる純関数。
 * 乱数 hex (6 字以上) と時刻を注入する (テスト容易性のため副作用を持たない)。
 */
export function suggestKeyId(now: Date, randomHex: string): string {
  const yyyymm = now.toISOString().slice(0, 7).replace('-', '');
  const suffix = randomHex
    .replace(/[^0-9a-f]/gi, '')
    .slice(0, 6)
    .toLowerCase();
  return `exam-${yyyymm}-${suffix}`;
}

/** 暗号学的乱数で 6 字の hex を作る (keyId サフィックス用)。 */
function randomHex6(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface GeneratedAuthorityKey {
  keyId: string;
  /** 出題者が安全保管する私的 JWK (絶対にコミットしない)。 */
  privateJwk: JsonWebKey;
  /** registry 登録用の公開 JWK。 */
  publicJwk: JsonWebKey;
  /** 生成時刻 (ISO)。registry entry の validFrom。 */
  validFrom: string;
  /** `examAuthorityKeys/{registry,localKeys}.ts` に追記する公開鍵 entry。 */
  registryEntry: ExamAuthorityKey;
}

/**
 * 出題者 ECDSA-P256 鍵ペアを生成する。秘密鍵は extractable で作り、私的 JWK として
 * 取り出す (教員がローカル保管できるように)。`keyId` / `validFrom` は呼び出し側で
 * 上書きしても良い (学期入りの keyId など)。
 */
export async function generateAuthorityKey(
  options: { keyId?: string; now?: Date } = {}
): Promise<GeneratedAuthorityKey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);

  const now = options.now ?? new Date();
  const keyId = options.keyId ?? suggestKeyId(now, randomHex6());
  const validFrom = now.toISOString();

  const registryEntry: ExamAuthorityKey = {
    keyId,
    algorithm: 'ECDSA-P256',
    publicKeyJwk: publicJwk,
    status: 'active',
    validFrom,
  };

  return { keyId, privateJwk, publicJwk, validFrom, registryEntry };
}
