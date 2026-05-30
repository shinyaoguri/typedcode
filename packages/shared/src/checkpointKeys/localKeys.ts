/**
 * ローカル開発用の追加公開鍵.
 *
 * このファイルはレポに「空配列」のデフォルトでコミットされている。各開発者は
 * 自分の dev 鍵を追加してから:
 *   git update-index --skip-worktree packages/shared/src/checkpointKeys/localKeys.ts
 * を実行して、以降の編集が git status に出ないようにする (撤回は --no-skip-worktree)。
 *
 * 本番公開鍵は `registry.ts` に append し、PR でレビューする。
 */

import type { CheckpointPublicKey } from './registry.js';

export const LOCAL_CHECKPOINT_PUBLIC_KEYS: readonly CheckpointPublicKey[] = [];
