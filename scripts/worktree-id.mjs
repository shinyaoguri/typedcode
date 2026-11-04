#!/usr/bin/env node
/**
 * この作業ツリー (git worktree) の識別子 (#552)。
 *
 * dev サーバ (editor / verify / workers) がこの値を名乗り、e2e の globalSetup
 * (packages/e2e/global-setup.ts) が「再利用しようとしているサーバはこの作業ツリーのものか」を
 * 照合する。並行する worktree が同じポートを握っていると、Playwright の reuseExistingServer は
 * TCP の応答だけを見て別の worktree のサーバにつながり、別の鍵で署名されて落ちるため。
 *
 * 値は sha256(realpath(リポジトリのルート)) の 16 進の先頭 12 桁。秘密ではなく、パスを
 * そのまま出さずに worktree を区別するためのもの。計算はこのファイルの 1 か所に置く
 * (相手の worktree のパスを引くときも、同じ式で `git worktree list` の各パスをハッシュする)。
 *
 * 単独で実行すると識別子を標準出力に出す (packages/workers の `dev` スクリプトが
 * `wrangler dev --var DEV_WORKTREE_ID:$(node ../../scripts/worktree-id.mjs)` で使う)。
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** editor / verify の dev サーバが識別子を返すレスポンスヘッダ。 */
export const WORKTREE_ID_HEADER = 'X-TypedCode-Worktree';

/** workers (`wrangler dev --var`) が識別子を受け取る変数。`/health` の `worktree` に出る。 */
export const WORKTREE_ID_VAR = 'DEV_WORKTREE_ID';

/** このファイルが属するリポジトリ (作業ツリー) のルート。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 作業ツリーのルートのパスから識別子を作る。symlink 越しのパスでも同じ値になるよう realpath を
 * 通す。消えた worktree (`git worktree list` の prunable) のように実在しないパスは、正規化した
 * パスのままハッシュする。
 * @param {string} root
 * @returns {string}
 */
export function worktreeIdOf(root) {
  let path = resolve(root);
  try {
    path = realpathSync(path);
  } catch {
    // 実在しないパスは解決せずに使う
  }
  return createHash('sha256').update(path).digest('hex').slice(0, 12);
}

/** この作業ツリーの識別子。 */
export function worktreeId() {
  return worktreeIdOf(REPO_ROOT);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(worktreeId());
}
