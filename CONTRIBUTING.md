# Contributing — ブランチ運用ガイド

TypedCode のブランチ運用は **タグ式 GitHub Flow** です。判断の根拠は [ADR-0028](docs/adr/0028-tag-based-github-flow.md) を参照。本ファイルは日々の**手順**を扱います。

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
| `feature/*` | 機能開発 | PR → preview URL 自動発行 |

- `develop` / `release/*` / `hotfix/*` ブランチは**ありません**。main が常にリリース候補です。
- **`staging` はブランチ名として予約** (staging Pages エイリアスと衝突するため使用禁止)。

## 普段の開発フロー

```bash
# 1. main から feature を切る
git switch main
git pull
git switch -c feature/my-change

# 2. 作業してコミット (Conventional Commits: feat:/fix:/docs:/test:/refactor: ...)
git add -A
git commit -m "feat(editor): add foo"

# 3. push して PR を作る (base = main)
git push -u origin feature/my-change
gh pr create --fill

# 4. CI 通過 + セルフレビュー後、Squash and Merge
gh pr merge --squash --delete-branch
```

- **PR は小さく** (目安 ±400 行)。1 PR = 1 つの関心事。
- マージ前に lint / type check / test / build が緑であること (main は required status checks で強制)。
- マージされると main push の CI が staging へ自動デプロイする。動作確認は `staging.<project>.pages.dev` で。

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
git switch main && git pull
git switch -c fix/critical-bug
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
- **Automatically delete head branches** を有効化 (長命ブランチは main のみで、ruleset が削除から保護している)

Rulesets:

- `main`: 削除・force-push 禁止 + **PR 必須 + required status checks (test / check / e2e)**
- `v*` タグ: 削除・更新禁止

コミットの規約は [Conventional Commits](https://www.conventionalcommits.org/) に従います。
