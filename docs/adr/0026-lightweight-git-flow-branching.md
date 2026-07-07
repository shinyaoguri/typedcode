# ADR-0026: ブランチ運用を軽量 Git Flow にする (release/* を省き develop→main は merge commit・feature→develop は squash)

- **Status**: Superseded by [ADR-0028](0028-tag-based-github-flow.md) (2026-07-07)
- **Date**: 2026-06-29
- **Deciders**: (PR 上の合意者 / レビュアー)
- **PR / Commit**: develop

## Context

これまで `develop` を長命の統合ブランチとして使い、`main` への昇格は意図的に保留してきた (リリースをイベントとして明示管理したいため)。だが**ブランチ運用とマージ方式が口頭ルールに留まっており**、明文化されていない。具体的に決めるべきは:

1. どのブランチ戦略を採るか (GitHub Flow / Git Flow / Trunk-Based)
2. 各マージ経路 (feature→develop, develop→main) でどのマージ方式 (merge commit / squash / rebase) を使うか
3. 本番緊急修正 (hotfix) の扱い

前提となる制約:

- **個人開発** (実質 1 名)。「QA チーム」「リリース凍結期間」「複数人の並行レビュー」は存在しない。
- ただし **1.0.0 を出荷済みの製品**であり、リリースは番号付きのイベントとして区切りたい (暗号証明エンジンの破壊的変更は `PROOF_FORMAT_VERSION` で管理される性質上、リリース境界が意味を持つ)。
- 既に **Conventional Commits** を実践しており、**ADR を積み重ねる stacked PR** の運用がある ([[adr-stacked-pr-merge]]: squash は stacked PR の土台 SHA を壊すため develop へは cherry-pick で flatten する)。
- `develop` を長命の統合ブランチとし main 昇格を保留する方針は既に確立している ([[release-strategy]])。

## Considered Options

### Option A: GitHub Flow (main + 短命 feature のみ)
- main を常にデプロイ可能に保ち、機能ごとに feature を切って main へ直接 PR。
- Pros: 最小構成・学習コストゼロ・継続的デプロイと好相性。世の中の小〜中規模デファクト。
- Cons: **リリースを番号付きイベントとして区切る場所がない** (main = 即本番)。既存の「develop で貯めて main へ昇格を保留」という運用と噛み合わない。→ **却下**。

### Option B: フル Git Flow (main + develop + feature/* + release/* + hotfix/*)
- develop を凍結 → `release/*` で QA → main、本番バグは `hotfix/*` で直す古典構成。
- Pros: リリース工程・緊急修正の経路が完全に定義される。複数人・複数日のリリースを吸収できる。
- Cons: `release/*` は本来**複数人の QA とリリース凍結期間を吸収する仕組み**。個人開発では QA チームも凍結期間も存在せず、`develop` がそのままリリース候補なので **release ブランチは空通しになり儀式コストだけ残る**。`hotfix/*` も常設運用にするほどの頻度がない。→ **過大として却下 (概念だけ採る)**。

### Option C: Trunk-Based Development (trunk へ高速集約 + feature flag)
- 超短命ブランチで trunk(main) に 1 日以内マージ、未完成は feature flag で隠す。
- Pros: 大人数の並行開発でマージ地獄を避ける。
- Cons: 大規模・高頻度チーム向けの規律 (即時レビュー・flag 管理基盤) が前提。個人開発では恩恵がなくコストだけ。リリース区切りの思想とも別物。→ **却下**。

### Option D: 軽量 Git Flow (フル Git Flow から release/* を省く・本 ADR)
- `main` / `develop` / `feature/*` は残し、**`release/*` は作らない** (develop がそのままリリース候補)。`hotfix/*` は常設運用にせず「本番緊急時に main から切る」概念だけ残す。
- Pros: 既存の develop 運用・リリース保留方針 ([[release-strategy]]) とそのまま整合。儀式コストの高い release ブランチを省ける。マージ方式を経路ごとに最適化できる。
- Cons: hotfix を main と develop の両方へ反映する手当てを忘れると分岐がずれる (手順で担保する)。→ **採用**。

## Decision

**Option D (軽量 Git Flow)** を採る。`release/*` は作らず、`develop` をそのままリリース候補とする。マージ方式は経路ごとに使い分ける。

### ブランチと経路

| ブランチ | 役割 | 着地元 → 着地先 | マージ方式 |
|---|---|---|---|
| `main` | リリース済み (本番) | `develop` → `main` | **merge commit** + バージョンタグ |
| `develop` | 常時統合 (普段の着地先) | `feature/*` → `develop` | **squash** |
| `feature/*` | 機能開発 | (PR を develop へ) | squash |
| `hotfix/*` | 本番緊急修正 (必要時のみ) | `main` から切り、`main` と `develop` の両方へ | 状況に応じる |

### マージ方式の使い分けと理由

- **feature → develop は squash**: 1 機能 = 1 コミットで develop の履歴を読みやすく保つ。途中の "wip"/"fix typo" を main 系列に持ち込まない。
- **develop → main は merge commit**: リリースの区切りを履歴に残す。ここで squash すると develop の全履歴が 1 コミットに潰れて辿れなくなるため使わない。
- **ADR stacked PR → develop は cherry-pick で flatten** ([[adr-stacked-pr-merge]]): squash は stacked PR の土台 SHA を壊すため、この経路だけ別運用。

→ この使い分けがあるため、GitHub のマージ許可は **3 方式とも有効のまま・デフォルトのみ squash** に設定する (squash 強制にすると develop→main の merge commit ができなくなる)。

### GitHub 既定ブランチ = `develop` (2026-07-02 追記)

依存更新を develop に集約する運用を徹底するため、GitHub の**既定ブランチを `main` から `develop` に変更**した。理由:

- **Dependabot のセキュリティ更新は常に既定ブランチへ PR を起票**し、`dependabot.yml` の `target-branch` (version update 用) では対象を変えられない。既定が `main` のままだと undici / esbuild 等のセキュリティ更新が `main` 直撃で飛び、「依存更新は develop へ」という本 ADR の方針と噛み合わなかった。
- 既定を `develop` にすることで、**version update (`target-branch: develop`) も security update (既定ブランチ) も develop に集約**される。新規 PR の base 既定や `git clone` の初期チェックアウトも develop に揃い、「普段の着地先は develop」という実態と一致する。
- **この変更はリリース昇格ポリシーを変えない**。`main` は依然リリース専用で、`develop → main` は merge commit + タグでのみ更新する ([[release-strategy]])。既定ブランチは Dependabot / PR / clone の初期値にすぎず、本番昇格の保留方針とは独立。
- `dependabot.yml` 側の `target-branch: develop` (version update 用の明示ピン) は既定と一致して冗長になるが、将来既定を戻しても version update が develop に留まる保険として残置する。

## Consequences

### Positive
- ブランチ運用とマージ方式が明文化され、口頭ルールへの依存が消える (将来の自分 / 貢献者 / AI エージェントが辿れる)。
- 既存の develop 統合・リリース保留 ([[release-strategy]]) / stacked PR flatten ([[adr-stacked-pr-merge]]) 運用を一切変えずに済む。
- リリースが merge commit + タグで履歴に明示的に区切られる。

### Negative / Trade-offs
- `release/*` を省いたため、将来チームが増えて QA 工程が必要になったら release ブランチを足す再判断が要る (その時は新 ADR)。
- hotfix を main と develop の両方へ反映する手順を人手で守る必要がある (CONTRIBUTING.md に明記して担保)。

### Follow-ups / 残課題
- **CONTRIBUTING.md** に日々のコマンド手順 (feature の切り方・PR・リリース・hotfix) を記述する (本 ADR の実務面)。
- GitHub リポジトリ設定: マージ許可を 3 方式有効・デフォルト squash・squash 後 head ブランチ自動削除に揃える。**既定ブランチは develop に変更済み (2026-07-02、上記「GitHub 既定ブランチ」節)**。
- branch protection (develop/main への直 push 禁止・CI 必須) の明文化は別途検討余地。

## References

- [[release-strategy]] (develop は長命の統合ブランチ・main 昇格は意図的に保留)
- [[adr-stacked-pr-merge]] (squash は ADR stacked PR の SHA を壊す → cherry-pick で flatten)
- [CONTRIBUTING.md](../../CONTRIBUTING.md) (本 ADR を実務手順に落とした運用ガイド)
- 外部: [A successful Git branching model (Vincent Driessen)](https://nvie.com/posts/a-successful-git-branching-model/) / [GitHub Flow](https://docs.github.com/en/get-started/quickstart/github-flow)
