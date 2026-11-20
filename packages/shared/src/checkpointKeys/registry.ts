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

/**
 * 鍵を運用する環境 (#321)。検証器は署名を検証した後で、鍵の環境を信頼するかを決める
 * (`keyEnvironment.ts`)。既定で信頼するのは production と development。
 *
 * - `production`: 本番の Worker (`typedcode-api`) の署名鍵
 * - `staging`: staging の Worker (`typedcode-api-staging`。PR プレビューもこの Worker を叩く) の署名鍵。
 *   main への push ごとに自動デプロイされ、鍵の管理水準も本番より低いので、本番の検証器は既定で信頼しない
 * - `development`: 各開発者の `localKeys.ts` (gitignore 済み) の鍵。`index.ts` が付ける (registry.ts には書かない)
 */
export type CheckpointKeyEnvironment = 'production' | 'staging' | 'development';

/** registry.ts に書いてよい環境 (development の鍵は localKeys.ts にだけ置く) */
export type RegistryCheckpointKeyEnvironment = Exclude<CheckpointKeyEnvironment, 'development'>;

/** 公開鍵のエントリのうち環境を除いた部分。localKeys.ts はこの形で書く (環境は index.ts が付ける) */
export interface LocalCheckpointPublicKey {
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

/** 検証器と Worker が扱う公開鍵のエントリ。環境は必須 (#321) */
export interface CheckpointPublicKey extends LocalCheckpointPublicKey {
  environment: CheckpointKeyEnvironment;
}

/** registry.ts のエントリ。環境は production か staging のどちらかを必ず書く (#321) */
export interface RegistryCheckpointPublicKey extends LocalCheckpointPublicKey {
  environment: RegistryCheckpointKeyEnvironment;
}

/**
 * 公開鍵レジストリ (append-only)
 *
 * **このファイルは運用される Worker (production / staging) の鍵だけを記述する。PR でレビューする想定。**
 * 各エントリには `environment` を必ず書く (#321。`__tests__/registryFormat.test.ts` が強制する)。
 * 検証器は既定で production の鍵だけを時刻証拠に数え、staging の鍵は明示したとき
 * (verify-cli の `--allow-staging-keys`、verify の staging ビルド) だけ数える。
 *
 * 各開発者の dev 鍵は `localKeys.ts` に書く (gitignore 済み。`.example` から作られる。#338)。
 * 鍵生成: `npm run gen-checkpoint-key -w @typedcode/workers`
 *
 * 運用ルール:
 * - 一度追加した鍵は revoke しても配列から削除しない (`status: 'revoked'` + `revokedAt` で残す)
 * - 過去 proof の検証可能性を維持するため historical commit から鍵を辿れることが重要
 */
export const CHECKPOINT_PUBLIC_KEYS: readonly RegistryCheckpointPublicKey[] = [
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
    environment: 'production',
  },
  {
    keyId: 'tcp-202606-0e46c9',
    algorithm: 'ECDSA-P256',
    publicKeyJwk: {
      key_ops: ['verify'],
      ext: true,
      kty: 'EC',
      x: 'Qi_DZKeKuvs20YHtIJ3xV_qPpBCFC0MjOVKmh8UhWD8',
      y: 'uzyGor_TS-hggx7TSm7k127NC8mJ4oPuDD1BwDuxnks',
      crv: 'P-256',
    },
    status: 'active',
    validFrom: '2026-06-04T16:09:16.485Z',
    environment: 'staging',
  },
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
