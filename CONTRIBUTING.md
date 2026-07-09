# Contributing — 開発の進め方

TypedCode のブランチ運用は **タグ式 GitHub Flow** です。判断の根拠は [ADR-0028](docs/adr/0028-tag-based-github-flow.md) を参照。本ファイルは日々の**手順** (ブランチ運用・worktree 並行作業・Issue の引き継ぎ・マージ後の掃除) を扱います。

## 全体像

```
tags                v1.1.0        v1.2.0
                      ●             ●          ← リリース = v* タグ (→ production デプロイ・承認ゲート)
main     ●──●──●──●──●──●──●──●──●──●──●────   ← 唯一の長命ブランチ (push で staging 自動デプロイ)
          ╲  ╱   ╲  ╱      ╲  ╱
feature   ●─●    ●─●        ●─●               ← 機能ごとに切る (PR → main, squash)
```

| 対象 | 役割 | デプロイ |
|---|---|---|
| `main` | 唯一の長命ブランチ・常時統合 | push → **staging** 自動 (`staging.<project>.pages.dev`) |
| `v*` タグ | 番号付きリリース | タグ push → **production** (承認ゲート付き) |
| `<type>/*` | 機能開発 (`feat/*`, `fix/*`, ...) | PR → preview URL 自動発行 |

- `develop` / `release/*` / `hotfix/*` ブランチは**ありません**。main が常にリリース候補です。
- **`staging` はブランチ名として予約** (staging Pages エイリアスと衝突するため使用禁止)。

## 普段の開発フロー

ブランチは `<type>/<短い説明>` で命名します。type は下記コミット型と同じものを使います (例: `feat/exam-timer`, `fix/posw-worker-race`, `docs/adr-0029`, `chore/ci-cache`)。

```bash
# 1. main 最新から worktree を作る (メインのチェックアウトは main のまま。詳細は「並行作業」)
git fetch origin
git worktree add .claude/worktrees/my-change -b feat/my-change origin/main
cd .claude/worktrees/my-change && npm ci

# 2. 作業してコミット (Conventional Commits: feat:/fix:/docs:/test:/refactor:/chore:/ci: ...)
git add -A
git commit -m "feat(editor): add foo"

# 3. push して PR を作る (base = main)
git push -u origin feat/my-change
gh pr create --fill

# 4. CI 通過 + セルフレビュー後、Squash and Merge → 掃除
gh pr merge --squash --delete-branch
```

- **PR は小さく** (目安 ±400 行)。1 PR = 1 つの関心事。
- **PR タイトルも Conventional Commits 形式にする**。Squash and Merge では PR タイトルがマージコミットのメッセージになります。
- マージ前に lint / type check / test / build が緑であること (main は required status checks で強制)。
- マージされると main push の CI が staging へ自動デプロイする。動作確認は `staging.<project>.pages.dev` で。
- **マージしたら、メインのチェックアウトから `git sweep` を実行して**ローカルブランチと worktree を掃除する (下記「マージ後の掃除」)。

## 並行作業 (git worktree)

作業はメインのチェックアウトでブランチを切り替えるのではなく、git worktree で並行作業します。リポジトリ直下は常に main のままにしておき、ブランチでの作業は worktree 側で行います。これにより、レビュー中に別タスクを並行で進めたり、main で動作確認しながらブランチを編集したりできます。Claude Code のセッションも同じ流儀で `.claude/worktrees/` 配下に worktree を作って動きます。

```sh
# 作成 (main 最新からブランチを切って .claude/worktrees/ 配下に展開)
git fetch origin
git worktree add .claude/worktrees/<name> -b <type>/<説明> origin/main
cd .claude/worktrees/<name>
npm ci

# ...編集 → commit → push → PR...

git worktree list   # 一覧確認
```

### 気をつけること

- **`node_modules` は worktree ごとに独立。** 作成した直後は必ず `npm ci` する。メインのチェックアウトも、`git pull` で lockfile が変わったら `npm ci` し直す (忘れると「コマンドが見つからない」系のエラーになる)
- **dev サーバのポートは全 worktree で共有。** editor (5173) / verify (5174) / workers (8787) を複数 worktree で同時起動すると衝突する。併用するときはポートを変える
- **skip-worktree はインデックス単位で、worktree 間で共有されない。** メインのチェックアウトで隠している `packages/shared/src/checkpointKeys/localKeys.ts` / `packages/workers/wrangler.toml` のローカル版や `.dev.vars` は、新しい worktree には存在しない (HEAD のプレースホルダ版がチェックアウトされる)。ユニットテストはそのまま通るが、worktree 内で workers をローカル起動するにはこれらの再セットアップが必要 ([packages/workers/CLAUDE.md](packages/workers/CLAUDE.md) の手順)。E2E は `npm run setup -w @typedcode/e2e` が鍵を実行時生成するので不要
- **`git stash` は全 worktree 共有。** 取り違えやすいので、作業を退避したいときは stash ではなく WIP コミットにする
- **同じブランチは一つの worktree にしかチェックアウトできない** (main はリポジトリ直下が使っているので、worktree で main は開けない)
- worktree の実体は `.claude/worktrees/` にあり、git 管理外 (.gitignore 済み)。消すときは `rm -rf` ではなく `git worktree remove` (または下記 sweep) を使う (git 側の登録も一緒に消えるため)

## マージ後の掃除 (git sweep)

掃除は個別の手作業ではなく `git sweep` に寄せます (方針の背景は [ADR-0029](docs/adr/0029-merge-cleanup-script.md))。仕組みは三段構え:

1. **リモートブランチ**: GitHub の「Automatically delete head branches」が有効なので、PR マージで自動削除される
2. **リモート追跡ブランチ**: `fetch.prune = true` (clone ごとに `git config fetch.prune true`) で fetch 時に自動削除される
3. **ローカルブランチと worktree**: [scripts/sweep.sh](scripts/sweep.sh) が upstream の消えた (`[gone]`) ブランチを worktree ごと削除する

セットアップ (clone ごとに一度):

```sh
git config fetch.prune true
git config alias.sweep '!bash scripts/sweep.sh'
```

運用方針: **PR をマージしたら、その流れでメインのチェックアウトから `git sweep` を実行する** (人でもエージェントでも、マージした者が実行する)。定期バッチにはせず、マージ直後の習慣として回します。

スクリプトは安全側に倒してあり、次の worktree はスキップして残します:

- 現在いる worktree
- 未コミットの変更がある worktree
- **使用中の worktree** (その中を cwd とするプロセスがいる。中で動いている Claude Code セッションやシェルなど)

スキップの理由が「自分自身」の場合——マージを終えたセッションがまだその worktree の中にいて「使用中のプロセスあり」と出る場合——セッションを閉じる必要はありません。Claude Code の `ExitWorktree` ツール (action: `keep`) でメインのチェックアウトに戻ってから `git sweep` を再実行すれば、その worktree も削除できます。`action: remove` で直接消す手もありますが、squash merge ではローカルコミットが「未マージ」と誤検知され確認を求められがちなので、`keep` で抜けて sweep に任せるほうが安全です (sweep は upstream の消滅で判定するため誤検知しない)。

スクリプトの動作検証は `npx vitest run scripts/sweep.test.ts` (使い捨てのリポジトリを組み立てる統合テスト)。CI 常設ではなく、スクリプトを変更したときに手元で回します。

### 注意: worktree を消すと、その中のセッションは再開できない

Claude Code のセッションは作業ディレクトリ単位で管理されるため、worktree を削除すると、その中で動いていたセッションは後から再開・追加依頼ができなくなります (`No conversation found with session ID` エラー)。

- **マージ後の追加依頼は、worktree の古いセッションに投げず、main から新しいセッション・新しい worktree で始める**
- 引き継ぎの真実を Issue に置く運用 (下記) を守っていれば、セッションが消えても失われる情報はない
- どうしても再開したい場合は、同じパスに worktree を作り直せば resume できる (会話ログ自体は `~/.claude/projects/` に残っている)

## Issue の書き方と引き継ぎ

このプロジェクトは AI エージェント (Claude Code など) との協働を前提とします。情報は二層で管理します。

- **作業レイヤー (揮発してよい)**: セッションのコンテキスト、エージェントのローカルメモリ、チャット履歴。作業効率を最大化するために積極的に活用する
- **恒久レイヤー (真実の置き場)**: Issue 本文・コメント、docs / ADR、コード、PR。**作業再開に必要な情報は必ずここに残す**

エージェントのメモリやチャット履歴はいつでもリセットされうる前提で、**Issue 本文・コメント・docs・コードだけを読めば、記憶ゼロの状態からでも作業を再開できる**状態を常に保ちます。メモリを使うことは問題ないが、メモリにしかない情報を作らない。

### Issue 本文に書くこと

[Issue テンプレート](.github/ISSUE_TEMPLATE/) がこの型を強制します。

- **目的** — なぜやるのか。関連する ADR / [docs/system-spec.md](docs/system-spec.md) / 既存 Issue と対応付ける
- **内容** — 何をつくるか。実装方針が決まっている場合はその理由も
- **受け入れ条件** — 「何ができたら完了か」を検証可能な形で (自動テスト・手動確認の別も)
- **関連情報** — 該当ファイル・docs・ADR・依存 Issue へのリンク。前提知識のポインタを惜しまない
- **スコープ外** — やらないことを明示し、スコープの膨張を防ぐ

### 作業中・引き継ぎ時のコメント

- **重要な決定・発見・方針変更は、その場で Issue コメントに記録する** (例: 試して駄目だったアプローチ、既存コードの罠)。恒久的な設計判断に昇格するものは ADR へ
- **作業を中断するとき・部分的に完了したときは引き継ぎコメントを残す**: ①完了したこと (PR 番号) ②残作業 ③詰まりどころ・注意点 ④次の一歩
- PR をマージしても Issue に残作業があるなら、Issue は閉じずに引き継ぎコメントで残作業を明確にする

### ラベル

- **種類ラベル** (Issue / PR に一つ): `bug` / `enhancement` / `documentation` / `security` など。Issue テンプレートが自動で付けるものはそのまま使う
- **パッケージラベル** (`pkg:shared` / `pkg:editor` / `pkg:verify` / `pkg:workers` / `pkg:e2e` / `pkg:repo`): PR には変更ファイルから **labeler が自動付与**する ([.github/labeler.yml](.github/labeler.yml))。Issue には着手対象が明らかな場合に手動で付ける
- `severity:*` はレビュー・トリアージ時の重要度の明示に使う

## リリース (v* タグ)

```bash
# 1. バージョン bump PR (ルート package.json。UI の About 表示に使われる)
npm version <X.Y.Z> --no-git-tag-version --workspaces-update=false
# → PR → squash merge

# 2. main 先端の CI が green なことを確認してからタグを打つ
gh run list --branch main -L 1
gh release create vX.Y.Z --target main --title "vX.Y.Z" --generate-notes
```

- タグ push で CI (test/check/e2e) が再実行され、green 後に **production デプロイが承認待ち**になる。Actions タブで Approve すると本番反映。
- タグは main の履歴上のコミットにのみ有効 (CI が ancestor 検証で強制)。
- **タグの付け替え・削除はしない** (ruleset でも禁止)。本番を戻したいときは fix を入れて**次のパッチタグ**を打つ。
- 破壊的な証明フォーマット変更は `PROOF_FORMAT_VERSION` とも対応させる。

## 本番緊急修正 (hotfix)

専用ブランチはありません。通常フローの最短経路で回します:

```bash
git fetch origin
git worktree add .claude/worktrees/critical-bug -b fix/critical-bug origin/main
# 修正 → PR → squash merge → staging で確認
gh release create vX.Y.(Z+1) --target main --generate-notes   # 即パッチリリース
```

main が唯一のブランチなので、旧 Git Flow のような「main と develop の両方へ反映」という手当ては不要です。

## ADR を積み重ねる stacked PR

ADR を連続で積む stacked PR は、**squash すると土台の SHA が変わって後続 PR が壊れる**。この経路だけは squash せず、**flatten ブランチに cherry-pick → PR → Rebase and merge** で main へ着地する (main は PR 必須のため直 push はしない)。詳細は [ADR-0028](docs/adr/0028-tag-based-github-flow.md) / 既存運用。

## GitHub リポジトリ設定 (推奨)

Settings → General → Pull Requests:

- **Default to squash merging** を有効化 (普段の feature→main を squash 既定に)
- Rebase merging も有効のまま (stacked PR の flatten 用)
- **Automatically delete head branches** を有効化 (長命ブランチは main のみで、ruleset が削除から保護している。`git sweep` の 1 段目でもある)

Rulesets:

- `main`: 削除・force-push 禁止 + **PR 必須 + required status checks (test / check / e2e)**
- `v*` タグ: 削除・更新禁止

コミットの規約は [Conventional Commits](https://www.conventionalcommits.org/) に従います。
