# ADR-0028: ブランチ運用をタグ式 GitHub Flow にする (main 1 本 + v* タグで production リリース)

- **Status**: Accepted (Supersedes [ADR-0026](0026-lightweight-git-flow-branching.md))
- **Date**: 2026-07-07
- **Deciders**: (PR 上の合意者 / レビュアー)
- **PR / Commit**: 移行 PR

## Context

ADR-0026 (2026-06-29) で軽量 Git Flow (main=リリース, develop=常時統合) を明文化したが、その後のレビューで運用実態との乖離と構造的なコストが確認された:

1. **リリース運用の形骸化**: タグは 0 個のまま、develop→main 昇格は 2026-06-05 (PR #64) を最後に停止し、develop が 163 コミット先行していた。「リリースを番号付きイベントとして区切る」という Git Flow 採用の根拠自体が実践されていなかった。昇格間隔が空くほど一括リリースの粒度が大きくなり、デプロイリスクが増す構造。
2. **Dependabot との構造的な不整合**: セキュリティ更新は常に既定ブランチ宛という GitHub の仕様に対し、既定ブランチを develop に変える回避策 (ADR-0026 追記, 2026-07-02) が必要だった。それ以前にはセキュリティ PR (#119) が main に直接マージされ、**develop 未反映の main-only コミット**が発生していた (次回昇格でのコンフリクト/先祖返りの火種)。
3. **hotfix 両面反映の運用リスク**: ADR-0026 自身が Negative として自認していた「main と develop の両方へ人手で反映」は、過去に分岐ずれの後始末コミット (902b1e1) を実際に生んでいる。

一方、ADR-0026 が GitHub Flow (Option A) を却下した理由は「リリースを番号付きイベントとして区切る場所がない (main = 即本番)」だったが、これは**「GitHub Flow = merge 即本番」という前提に立った誤り**で、タグリリース変種を検討していなかった。

## Considered Options

### Option A: 軽量 Git Flow の維持 (ADR-0026 現状)
- Pros: 移行コストゼロ。常設 staging (develop) と本番ブランチ (main) の分離が明確。
- Cons: 上記 1〜3 のコストを払い続ける。リリース運用が回っていない実態では「2 ブランチの維持費だけ払っている」状態。→ **却下**。

### Option B: タグ式 GitHub Flow (本 ADR)
- `main` 1 本のみ。全 PR は main 宛 (squash)。main push で **staging** に自動デプロイ。
- **production へのデプロイは `v*` タグ push をトリガー**にする。タグ = 番号付きリリースイベントそのもので、GitHub Releases がリリース台帳になる。既存の GitHub Environment "production" 承認ゲートはそのまま生きる。
- Pros: ADR-0026 の却下理由「リリースの区切りがない」を**タグで解消**しつつ、ブランチ 1 本化で Dependabot 問題・main-only コミット・hotfix 両面反映が構造的に消滅する。既定ブランチ回避策 (2026-07-02) も不要になり main に戻せる。`PROOF_FORMAT_VERSION` との対応付けはタグ (リリースノート) で継続できる。
- Cons: 「本番に何が入っているか」のブランチ表現を失う (タグ `git checkout vX.Y.Z` で代替)。staging の安定 URL エイリアスを develop から staging へ変える必要 (Turnstile ドメイン再登録を伴う)。→ **採用**。

### Option C: 即本番の教科書的 GitHub Flow (merge = production デプロイ)
- Pros: 最小構成。
- Cons: リリースを意図的なイベントとして区切れない (試験運用中に本番を触らない、という製品特性に反する)。承認ゲートを毎マージに掛けると staging の自動性を失う。→ **却下** (ADR-0026 の却下理由はこの変種にのみ妥当だった)。

## Decision

**Option B (タグ式 GitHub Flow)** を採る。

### ブランチ・タグと経路

| 対象 | 役割 | トリガ → デプロイ | マージ方式 |
|---|---|---|---|
| `main` | 唯一の長命ブランチ・常時統合・常時リリース候補 | push → **staging** 自動 (Pages `--branch=staging`) | feature→main は **squash** |
| `v*` タグ | 番号付きリリース | タグ push → **production** (Environment 承認ゲート) | `gh release create` で作成 |
| `feature/*` | 機能開発 | PR → preview URL | squash |

- `develop` / `release/*` / `hotfix/*` は廃止。緊急修正は「main へ fix PR → 即パッチタグ」の最短経路で行う。
- `staging` はブランチ名として**予約** (Pages の staging エイリアスと衝突するため)。
- ADR stacked PR の cherry-pick flatten は維持するが、main が PR 必須になるため「flatten ブランチ → PR → **Rebase and merge**」方式に変更する ([[adr-stacked-pr-merge]])。

### リリースゲート (タグの安全装置)

1. タグ push でも test / check / e2e を**再実行**する (タグは CI 未通過コミットにも打てるため、タグ時の再検証が唯一の強制ゲート)。
2. deploy-production はタグコミットが **main の祖先であることを検証** (`git merge-base --is-ancestor`) してからデプロイする。
3. Pages の production デプロイは `--branch=main` を明示する (タグ checkout は detached HEAD のため、省略すると preview 扱いになる)。
4. ruleset で `v*` タグの削除・更新を禁止。本番の巻き戻しは**新しいパッチタグ**で行う (タグ付け替えはしない)。
5. main は PR 必須 + required status checks (test / check / e2e)。

### GitHub / Cloudflare 設定の変更

- GitHub 既定ブランチを develop → **main に戻す** (ADR-0026 の 2026-07-02 回避策は不要になる。dependabot.yml の `target-branch` も削除)。
- Environment `production` の deployment branch policy は「タグを許可する」状態を維持する (branch のみに絞るとタグデプロイが拒否されリリース不能になる)。
- Turnstile staging widget の Domain に `staging.<project>.pages.dev` を登録。Workers の `ALLOWED_ORIGINS` は staging がワイルドカード (`https://*.typedcode.pages.dev`) のため**変更不要**。

## Consequences

### Positive
- リリースが GitHub Releases + タグとして履歴に残り、承認ゲートで意図的なイベントであり続ける。
- Dependabot・セキュリティ更新・新規 PR・clone 初期値がすべて main に自然集約される (回避策の廃止)。
- main-only コミット / 分岐ずれ / hotfix 両面反映という事故クラスが構造的に消滅する。
- 昇格という重いイベントがなくなり、小さく頻繁なリリースが可能になる。

### Negative / Trade-offs
- 「本番のコード」をブランチとして checkout できない (タグで代替: `git checkout v1.1.0`)。
- リリースごとに CI を再実行するコスト (~20 分)。リリース頻度が上がって問題になったら e2e のみタグ時 skip を再検討する。
- 将来チームが増えて統合ブランチが再び必要になったら、その時点で新 ADR を起こす。

## References

- [ADR-0026](0026-lightweight-git-flow-branching.md) (superseded — 軽量 Git Flow と当時の前提)
- [[release-strategy]] / [[adr-stacked-pr-merge]] (メモリ: 移行に伴い更新)
- [CONTRIBUTING.md](../../CONTRIBUTING.md) (本 ADR を実務手順に落とした運用ガイド)
- 外部: [GitHub Flow](https://docs.github.com/en/get-started/quickstart/github-flow) / [nvie の追記 (2020): 継続的デリバリーの Web アプリには Git Flow より GitHub Flow 系を推奨](https://nvie.com/posts/a-successful-git-branching-model/)
