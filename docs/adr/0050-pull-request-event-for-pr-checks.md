# ADR-0050: PR の検査は pull_request で走らせ、pull_request_target は labeler だけに許可する

- **Status**: Accepted
- **Date**: 2026-11-10
- **Deciders**: shinyaoguri (#685 のコメントで決定)
- **PR / Commit**: #685 を閉じる PR

## Context

PR の検査 (`pr-title.yml`・`pr-checks.yml`) と `labeler.yml` は `pull_request_target` で動いていた。理由は「fork からの PR でも base リポジトリ側の設定で走らせるため」で、checkout は base ブランチだけ・permissions は read のみ (labeler は `pull-requests: write`) と、PR のコードを実行しない形にしてあった。

GitHub は公開リポジトリに `pull_request_target` を止める既定のポリシーを入れ、**2026-12-02 に強制する** (docs.github.com「Securely using pull_request_target」)。2026-11-09 にはその予定のブラウンアウトがあり、PR #680 で 3 本が毎回 `startup_failure` になった (再実行も不可)。`pr-title`・`require-tests`・`require-visual-evidence`・`require-issue` は ruleset の必須チェックなので、走らないと全 PR がマージできなくなる。

GitHub の指針は「秘密や書き込み権限が要らないなら `pull_request` を使い、`pull_request_target` は必要なときだけイベントポリシーで明示的に許可する」。

## Considered Options

### Option A: 3 本とも `pull_request_target` のまま、ポリシーで明示的に許可する
- Pros: ワークフローを変えない。判定ロジック (`scripts/require-*.mjs`) は常に base 側の版で走るので、PR が自分のゲートを書き換えて通すことができない
- Cons: 書き込み権限の要らない検査にまで、fork の PR に対して base の権限で走る event を許可する。指針 (必要なときだけ) から外れ、許可の範囲が広い

### Option B: 検査 2 本は `pull_request` へ移し、labeler だけ `pull_request_target` を許可する (採用)
- Pros: 読み取りだけの検査は指針どおりの event になり、fork の PR には read のみのトークンしか渡らない。許可は書き込みが本当に要る 1 本に絞られる。判定ロジックの変更がその PR 自身の検査に効く
- Cons: ワークフローと `scripts/require-*.mjs` が PR 側の版で走るので、PR が自分のゲートを書き換えて通せる

### Option C: 3 本とも `pull_request` へ移し、labeler の書き込みは `workflow_run` に分ける
- Pros: `pull_request_target` を一切使わない
- Cons: labeler を 2 段に分ける構成が増える。ラベル付けは必須チェックではなく、`actions/labeler` は checkout せず base の設定だけを読むので、許可して残す危険は小さい

## Decision

Option B。読み取りだけの検査に base の権限で走る event は要らず、指針に沿って許可の範囲を labeler の 1 本に絞る。Option B の Cons (PR が自分のゲートを書き換えられる) は、書き換えが必ず差分に出ること、外部からの PR がほとんど無い運用であることから受け入れる。

## Consequences

### Positive
- 既定の保護が強制された後も、必須チェックは PR を開く・push・本文編集・ラベル変更で走る
- `scripts/require-*.mjs` を変えた PR は、新しいロジックで自分自身が検査される

### Negative / Trade-offs
- PR は自分のゲート (ワークフローと `scripts/require-*.mjs`) を書き換えて通せる。レビューでは `.github/workflows/` と `scripts/require-*.mjs` の差分を見落とさない
- `pull_request` はマージコンフリクトのある PR では走らないので、コンフリクトの間は必須チェックが付かない。解消すると走る (どのみちマージできない状態なので実害は無い)
- labeler を動かし続けるには、2026-12-02 までに Settings → Actions → Policies で `labeler.yml` だけを対象に `pull_request_target` を許可する設定が要る。この設定はリポジトリに定義ファイルが無い

### Follow-ups / 残課題
- 外部からの PR が増えたら、ゲートの書き換えを止める手段 (CODEOWNERS で `.github/workflows/`・`scripts/require-*.mjs` をレビュー必須にする等) を検討する

## References

- `.github/workflows/pr-checks.yml`・`pr-title.yml`・`labeler.yml`
- ADR-0034 (require-tests)、ADR-0036 (require-visual-evidence)、ADR-0038 (require-issue)
- #685、PR #680 (ブラウンアウトで止まった PR)
- docs.github.com「Securely using pull_request_target」「Governing execution of GitHub Actions workflows」
