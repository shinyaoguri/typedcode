#!/usr/bin/env bash
# マージ済みブランチと worktree の掃除(`git sweep` エイリアスの実体)。
# 背景と判断は docs/adr/0029-merge-cleanup-script.md を参照。
#
# 削除対象(いずれも対応する worktree ごと削除する):
#   - upstream が消えた([gone])ローカルブランチ。GitHub 側で
#     「Automatically delete head branches」が有効なので、PR マージ後に
#     メインのチェックアウトからこれを実行するだけでローカルも片付く
#   - 一度も push されておらず、既定ブランチに完全に含まれる worktree-* ブランチ
#     (セッションの EnterWorktree が自動生成するプレースホルダー。作業が別名の
#     ブランチで PR されると、固有のコミットを持たないまま残る)
#
# 安全側スキップ(削除しないケース):
#   - 現在いる worktree
#   - 未コミットの変更がある worktree
#   - 使用中の worktree(そのディレクトリを cwd とするプロセスがいる。
#     例: 中で動いている Claude Code セッションやシェル。worktree を消すと
#     その中のセッションは再開できなくなるため)
#
# セットアップ(clone ごとに一度): git config alias.sweep '!bash scripts/sweep.sh'
set -euo pipefail

git fetch --prune

top=$(git rev-parse --show-toplevel)
main_ref=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD || echo origin/main)

# ディレクトリ以下を cwd とするプロセスがいるか(lsof が使えない環境では偽を返す)
# 注意: grep -q を使うと lsof が SIGPIPE になり pipefail に拾われるので、全読みしてから判定する
in_use() {
  local hits
  hits=$(lsof -Fn -d cwd 2>/dev/null | grep -E "^n$1(/|$)" || true)
  [ -n "$hits" ]
}

git for-each-ref refs/heads --format='%(refname:short)|%(upstream)|%(upstream:track)|%(worktreepath)' |
while IFS='|' read -r branch upstream track wt; do
  if [ "$track" = "[gone]" ]; then
    : # マージ済み(upstream 消滅)
  elif [ -z "$upstream" ] && [[ "$branch" == worktree-* ]] &&
    git merge-base --is-ancestor "$branch" "$main_ref" 2>/dev/null; then
    : # EnterWorktree のプレースホルダー(未 push・固有コミットなし)
  else
    continue
  fi

  if [ -n "$wt" ] && [ "$wt" = "$top" ]; then
    echo "skip: ${branch}(現在いる worktree: ${wt})"
    continue
  fi

  if [ -n "$wt" ]; then
    if [ -n "$(git -C "$wt" status --porcelain)" ]; then
      echo "skip: ${branch}(未コミットの変更あり: ${wt})"
      continue
    fi
    if in_use "$wt"; then
      echo "skip: ${branch}(使用中のプロセスあり。セッションが動いていないか確認: ${wt})"
      continue
    fi
    git worktree remove "$wt" || {
      echo "skip: ${branch}(worktree remove 失敗: ${wt})"
      continue
    }
  fi

  git branch -D "$branch" >/dev/null
  if [ -n "$wt" ]; then
    echo "removed: ${branch}(worktree も削除: ${wt})"
  else
    echo "removed: $branch"
  fi
done
