import { CHECKPOINT_PUBLIC_KEYS as REGISTRY_KEYS, findCheckpointPublicKey as findInRegistry } from './registry.js';
import { LOCAL_CHECKPOINT_PUBLIC_KEYS } from './localKeys.js';
import type { CheckpointPublicKey, LocalCheckpointPublicKey } from './registry.js';

/**
 * localKeys.ts の鍵に環境 `development` を付ける (#321)。localKeys.ts に環境が書かれていても上書きする
 * (gitignore 済みの手元の鍵を production や staging と名乗らせない)。
 */
export function asDevelopmentKeys(keys: readonly LocalCheckpointPublicKey[]): CheckpointPublicKey[] {
  return keys.map((key) => ({ ...key, environment: 'development' }));
}

/**
 * 公開鍵 (registry.ts の production / staging) と各開発者のローカル公開鍵 (localKeys.ts) を
 * マージした完全なレジストリ。
 *
 * `registry.ts` はレビュー必須の公式鍵リスト。
 * `localKeys.ts` は各開発者が自分の dev 鍵を追加する場所 (gitignore 済み。無ければ
 * `npm install` (postinstall) / e2e の setup / doctor が `localKeys.ts.example` から作る。#338)。
 * localKeys.ts の鍵の環境は常に `development` になる (#321)。
 */
export const CHECKPOINT_PUBLIC_KEYS: readonly CheckpointPublicKey[] = [
  ...REGISTRY_KEYS,
  ...asDevelopmentKeys(LOCAL_CHECKPOINT_PUBLIC_KEYS),
];

export function findCheckpointPublicKey(
  keyId: string,
  registry: readonly CheckpointPublicKey[] = CHECKPOINT_PUBLIC_KEYS
): CheckpointPublicKey | undefined {
  // registry 引数が省略された場合は merged 配列を使う
  if (registry === CHECKPOINT_PUBLIC_KEYS) {
    return registry.find((k) => k.keyId === keyId);
  }
  // 明示的に渡された registry を尊重 (テストでの注入に使う)
  return findInRegistry(keyId, registry);
}

export type {
  CheckpointPublicKey,
  CheckpointPublicKeyStatus,
  CheckpointKeyEnvironment,
  LocalCheckpointPublicKey,
  RegistryCheckpointKeyEnvironment,
  RegistryCheckpointPublicKey,
} from './registry.js';

// 鍵の環境の信頼 (#321)。verify-cli と verify が同じ関数で決める。
export {
  ALL_CHECKPOINT_KEY_ENVIRONMENTS,
  DEFAULT_TRUSTED_CHECKPOINT_KEY_ENVIRONMENTS,
  isCheckpointKeyEnvironmentTrusted,
  trustedCheckpointKeyEnvironments,
} from './keyEnvironment.js';
export type { UntrustedEnvironmentKey } from './keyEnvironment.js';

// 有効期間 / 失効の判定は checkpoint 鍵と出題者鍵で共通 (#233)。
export { checkRegistryKeyValidityAt, registryKeyTrustStatus } from './keyValidity.js';
export type {
  RegistryKeyTrustStatus,
  RegistryKeyDateField,
  RegistryKeyValidityFields,
  RegistryKeyVerdict,
} from './keyValidity.js';
