import { EXAM_AUTHORITY_KEYS as REGISTRY_KEYS, findExamAuthorityKey as findInRegistry } from './registry.js';
import { LOCAL_EXAM_AUTHORITY_KEYS } from './localKeys.js';
import type { ExamAuthorityKey } from './registry.js';

/**
 * 本番公開鍵 (registry.ts) と各出題者のローカル公開鍵 (localKeys.ts) を
 * マージした完全な exam authority レジストリ。
 *
 * `registry.ts` はレビュー必須の公式鍵リスト。
 * `localKeys.ts` は各出題者が自分の dev 鍵を追加する場所 (skip-worktree 推奨)。
 */
export const EXAM_AUTHORITY_KEYS: readonly ExamAuthorityKey[] = [...REGISTRY_KEYS, ...LOCAL_EXAM_AUTHORITY_KEYS];

export function findExamAuthorityKey(
  keyId: string,
  registry: readonly ExamAuthorityKey[] = EXAM_AUTHORITY_KEYS
): ExamAuthorityKey | undefined {
  // registry 引数が省略された場合は merged 配列を使う
  if (registry === EXAM_AUTHORITY_KEYS) {
    return registry.find((k) => k.keyId === keyId);
  }
  // 明示的に渡された registry を尊重 (テストでの注入に使う)
  return findInRegistry(keyId, registry);
}

export type { ExamAuthorityKey, ExamAuthorityKeyStatus } from './registry.js';
