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
 * 公開鍵レジストリ (append-only)
 *
 * 本番運用前のプレースホルダ。実鍵が発行されたら追記する。
 * テストでは fixture から動的に追加するため、初期状態は空配列。
 */
export const CHECKPOINT_PUBLIC_KEYS: readonly CheckpointPublicKey[] = [
  // 例 (実装時の参考):
  // {
  //   keyId: 'tcp-2026-01',
  //   algorithm: 'ECDSA-P256',
  //   publicKeyJwk: { kty: 'EC', crv: 'P-256', x: '...', y: '...' },
  //   status: 'active',
  //   validFrom: '2026-01-01T00:00:00Z',
  // },
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
