import { CHECKPOINT_PUBLIC_KEYS as REGISTRY_KEYS, findCheckpointPublicKey as findInRegistry } from './registry.js';
import { LOCAL_CHECKPOINT_PUBLIC_KEYS } from './localKeys.js';
import type { CheckpointPublicKey } from './registry.js';

/**
 * 本番公開鍵 (registry.ts) と各開発者のローカル公開鍵 (localKeys.ts) を
 * マージした完全なレジストリ。
 *
 * `registry.ts` はレビュー必須の公式鍵リスト。
 * `localKeys.ts` は各開発者が自分の dev 鍵を追加する場所 (skip-worktree 推奨)。
 */
export const CHECKPOINT_PUBLIC_KEYS: readonly CheckpointPublicKey[] = [
  ...REGISTRY_KEYS,
  ...LOCAL_CHECKPOINT_PUBLIC_KEYS,
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
} from './registry.js';
