/**
 * ローカル開発用の追加 exam authority 公開鍵 (ADR-0006)。
 *
 * このファイルはレポに「空配列」のデフォルトでコミットされている。各出題者は
 * 自分の dev 鍵を追加してから:
 *   git update-index --skip-worktree packages/shared/src/examAuthorityKeys/localKeys.ts
 * を実行して、以降の編集が git status に出ないようにする (撤回は --no-skip-worktree)。
 *
 * 本番公開鍵は `registry.ts` に append し、PR でレビューする。
 */

import type { ExamAuthorityKey } from './registry.js';

export const LOCAL_EXAM_AUTHORITY_KEYS: readonly ExamAuthorityKey[] = [];
