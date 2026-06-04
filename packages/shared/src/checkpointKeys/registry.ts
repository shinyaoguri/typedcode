/**
 * Signed checkpoint 公開鍵レジストリ
 *
 * このファイルは git で永続管理される唯一の公開鍵真実情報源。
 * - 鍵は revoke しても削除しない (`status: 'revoked'` で残す)
 * - 過去 proof の検証可能性を維持するため、historical commit から鍵を辿れる
 * - Workers / verifier / verify-cli すべてここを参照する
 */

import type { SignedCheckpointAlgorithm } from '../types/proof.js';

export type CheckpointPublicKeyStatus = 'active' | 'revoked';

export interface CheckpointPublicKey {
  keyId: string;
  algorithm: SignedCheckpointAlgorithm;
  publicKeyJwk: JsonWebKey;
  status: CheckpointPublicKeyStatus;
  /** 鍵が有効になった時刻 (ISO 8601) */
  validFrom: string;
  /** 鍵の有効終了時刻 (ISO 8601)。未設定なら未失効 */
  validUntil?: string;
  /**
   * revoke された時刻 (ISO 8601)。設定されると status は 'revoked' のはず。
   * この時刻より前に署名された envelope は warning 付きで trust する
   */
  revokedAt?: string;
  /** 人間可読な説明 (オプショナル) */
  description?: string;
}

/**
 * 本番公開鍵レジストリ (append-only)
 *
 * **このファイルは本番運用される鍵のみを記述する。PR でレビューする想定。**
 *
 * 各開発者の dev 鍵は `localKeys.ts` に書く (skip-worktree 推奨)。
 * 鍵生成: `npm run gen-checkpoint-key -w @typedcode/workers`
 *
 * 運用ルール:
 * - 一度追加した鍵は revoke しても配列から削除しない (`status: 'revoked'` + `revokedAt` で残す)
 * - 過去 proof の検証可能性を維持するため historical commit から鍵を辿れることが重要
 */
export const CHECKPOINT_PUBLIC_KEYS: readonly CheckpointPublicKey[] = [
  // 本番環境
  {
    keyId: 'tcp-202605-fd6d42',
    algorithm: 'ECDSA-P256',
    publicKeyJwk: {
      kty: 'EC',
      crv: 'P-256',
      x: 'tq1WL46ZTs2X2f1afNe8m-icdz9G7w5NUZX7QzY2doU',
      y: 'kNtc3gG0fcDeL44naUx0TVUV3wKqupWKXLoNZjU5u8A',
    },
    status: 'active',
    validFrom: '2026-05-28T14:43:43.346Z',
    description: 'Initial signing key. Private half lives in the Workers secret CHECKPOINT_SIGNING_KEY_JWK.',
  },
  // staging環境
  {
    keyId: "tcp-202606-0e46c9",
    algorithm: "ECDSA-P256",
    publicKeyJwk: {
      "key_ops": [
        "verify"
      ],
      ext: true,
      kty: "EC",
      x: "Qi_DZKeKuvs20YHtIJ3xV_qPpBCFC0MjOVKmh8UhWD8",
      y: "uzyGor_TS-hggx7TSm7k127NC8mJ4oPuDD1BwDuxnks",
      crv: "P-256"
    },
    status: "active",
    validFrom: "2026-06-04T16:09:16.485Z"
  }
] as const;

/**
 * keyId から公開鍵を解決する。registry に存在しなければ undefined。
 */
export function findCheckpointPublicKey(
  keyId: string,
  registry: readonly CheckpointPublicKey[] = CHECKPOINT_PUBLIC_KEYS
): CheckpointPublicKey | undefined {
  return registry.find((k) => k.keyId === keyId);
}
