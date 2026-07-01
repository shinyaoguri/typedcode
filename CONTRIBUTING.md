# Contributing — ブランチ運用ガイド

TypedCode のブランチ運用は **軽量 Git Flow** です。判断の根拠は [ADR-0026](docs/adr/0026-lightweight-git-flow-branching.md) を参照。本ファイルは日々の**手順**を扱います。

## 全体像

```
main      ──────────●────────────●─────   ← リリース時だけ develop からマージ + タグ
                   ╱            ╱
develop  ●──●──●──●──●──●──●──●──●──●────   ← 常時統合 (普段の着地先)
          ╲  ╱   ╲  ╱      ╲  ╱
feature   ●─●    ●─●        ●─●            ← 機能ごとに切る (PR → develop, squash)
```

| ブランチ | 役割 | 着地先 | マージ方式 |
|---|---|---|---|
| `main` | リリース済み (本番) | — | (develop からの受け先) |
| `develop` | 常時統合・普段の着地先 | `main` (リリース時) | **merge commit** + タグ |
| `feature/*` | 機能開発 | `develop` | **squash** |
| `hotfix/*` | 本番緊急修正 (必要時のみ) | `main` と `develop` 両方 | 状況に応じる |

`release/*` は**作りません** (develop がそのままリリース候補)。

## 普段の開発フロー

```bash
# 1. develop から feature を切る
git switch develop
git pull
git switch -c feature/my-change

# 2. 作業してコミット (Conventional Commits: feat:/fix:/docs:/test:/refactor: ...)
git add -A
git commit -m "feat(editor): add foo"

# 3. push して PR を作る (base = develop)
git push -u origin feature/my-change
gh pr create --base develop --fill

# 4. CI 通過 + セルフレビュー後、Squash and Merge
gh pr merge --squash --delete-branch
```

- **PR は小さく** (目安 ±400 行)。1 PR = 1 つの関心事。
- マージ前に lint / type check / test / build が緑であること。

## リリース (develop → main)

```bash
git switch main
git pull
git merge --no-ff develop          # merge commit を残す (squash しない)
git tag -a v1.1.0 -m "Release v1.1.0"
git push origin main --tags
```

- **必ず `--no-ff` (merge commit)**。squash すると develop の履歴が 1 コミットに潰れて辿れなくなる。
- バージョンタグ (`vX.Y.Z`) でリリースを区切る。破壊的な証明フォーマット変更は `PROOF_FORMAT_VERSION` とも対応させる。

## 本番緊急修正 (hotfix)

```bash
git switch main
git switch -c hotfix/critical-bug
# 修正してコミット
git switch main && git merge --no-ff hotfix/critical-bug && git tag v1.1.1
git switch develop && git merge --no-ff hotfix/critical-bug   # develop へも忘れず反映
```

- **main と develop の両方へ反映**するのを忘れないこと (片方だけだと次のリリースで先祖返りする)。

## ADR を積み重ねる stacked PR

ADR を連続で積む stacked PR は、**squash すると土台の SHA が変わって後続 PR が壊れる**。この経路だけは squash せず **cherry-pick で develop へ flatten** する (詳細は [ADR-0026](docs/adr/0026-lightweight-git-flow-branching.md) / 既存運用)。

## GitHub リポジトリ設定 (推奨)

Settings → General → Pull Requests:

- マージ方式は **3 方式とも有効のまま** (develop→main で merge commit を使うため squash 強制にしない)
- **Default to squash merging** を有効化 (普段の feature→develop を squash 既定に)
- **Automatically delete head branches** を有効化

コミットの規約は [Conventional Commits](https://www.conventionalcommits.org/) に従います。
