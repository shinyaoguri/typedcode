/** デプロイ後の readiness: 実際に cp を署名し、同梱 registry で検証する (#579)。 */
import {
  CHECKPOINT_PUBLIC_KEYS,
  createSignedCheckpointEnvelope,
  verifyCheckpointSignature,
} from '@typedcode/shared/checkpoint';
import { getSigningKey, type CheckpointEnv } from './checkpoint.js';

type SigningHealth = { ok: true; keyId: string } | { ok: false; reason: string };
let cached: { keyId: string; jwkText: string; result: Promise<SigningHealth> } | undefined;

export async function checkSigningHealth(env: CheckpointEnv): Promise<SigningHealth> {
  try {
    // 有効期間はキャッシュより先に毎回確認する (isolate の寿命中にも失効しうる)。
    const signer = await getSigningKey(env);
    const jwkText = env.CHECKPOINT_SIGNING_KEY_JWK!;
    if (!cached || cached.keyId !== signer.keyId || cached.jwkText !== jwkText) {
      cached = {
        keyId: signer.keyId,
        jwkText,
        // Promise を保持し、同時に来た probe の署名・検証も一度にまとめる。
        result: probe(signer).catch(() => ({ ok: false, reason: 'SIGNING_ERROR' })),
      };
    }
    return await cached.result;
  } catch (error) {
    // 例外文には設定値が含まれうる。公開するのは既知の固定コードだけ。
    const code = (error as { code?: string } | null)?.code;
    const reasons = [
      'SIGNING_KEY_NOT_CONFIGURED',
      'SIGNING_KEY_UNKNOWN',
      'SIGNING_KEY_INVALID',
      'SIGNING_KEY_MISMATCH',
    ];
    return { ok: false, reason: code && reasons.includes(code) ? code : 'SIGNING_ERROR' };
  }
}

async function probe(signer: { keyId: string; key: CryptoKey }): Promise<SigningHealth> {
  const now = new Date().toISOString();
  const hash = '0'.repeat(64);
  // 固定のダミー入力。KV・Turnstile は使わず、署名や payload は応答に公開しない。
  const envelope = await createSignedCheckpointEnvelope(
    {
      sessionId: 'health',
      tabId: 'health',
      checkpointIndex: 0,
      eventIndex: 0,
      initialEventChainHash: hash,
      chainHash: hash,
      contentHash: hash,
      previousSignedCheckpointHash: null,
      totalEventsSincePrevious: 0,
      clientTimestamp: now,
    },
    { serverTimestamp: now, firstSeenAt: now },
    { keyId: signer.keyId, privateKey: signer.key }
  );
  const verified = await verifyCheckpointSignature(envelope, CHECKPOINT_PUBLIC_KEYS);
  return verified.valid ? { ok: true, keyId: signer.keyId } : { ok: false, reason: 'SIGNATURE_VERIFICATION_FAILED' };
}
