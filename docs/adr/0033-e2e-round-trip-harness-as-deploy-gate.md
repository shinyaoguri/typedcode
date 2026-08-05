# ADR-0033: E2E は暗号成果物をオラクルにした round-trip に限定し、全 deploy の必須ゲートにする

- **Status**: Accepted
- **Date**: 2026-08-05 (決定・実装は 2026-07 の PR #116〜#118 / #192。事後に ADR 化)
- **Deciders**: @shinyaoguri
- **PR / Commit**: [#116](https://github.com/shinyaoguri/typedcode/pull/116) [#117](https://github.com/shinyaoguri/typedcode/pull/117) [#118](https://github.com/shinyaoguri/typedcode/pull/118) [#192](https://github.com/shinyaoguri/typedcode/pull/192) / `76aec6b` `8c6e9fb`

## Context

TypedCode の価値は「キーストロークの証明が本当に検証を通り、改竄すると本当に落ちる」ことに尽きる。しかしこの性質は 1 パッケージの中に閉じていない。記録は editor、チェーンと PoSW は shared、判定は verify-cli、時刻アンカーは workers にあり、**各パッケージのユニットテストが全部緑でも、繋いだときに壊れている**という失敗が実際に複数回起きていた (リロード時の root アンカー喪失、`insertParagraph` の検出漏れ、pure-typing の誤検知など)。

さらに悪いのは、検証器が壊れる方向の失敗である。改竄を素通しする検証器はユニットテストでは緑に見え、しかも「緑だから安全」と誤読される。

制約:

- PoSW の完全検証は計算量が重く、全シナリオで回すと CI が現実的な時間に収まらない
- Playwright の `keyboard.type` は CDP 経由で `isTrusted=true` になるため、合成打鍵 ([ADR-0018](0018-istrusted-capture.md)) の負のシナリオは別の注入手段が要る
- deploy は Cloudflare へ出ていく不可逆な操作で、[ADR-0028](0028-tag-based-github-flow.md) のタグ式 GitHub Flow では `v*` タグが直接 production に繋がる

## Considered Options

### Option A: ユニットテストのみ (E2E を持たない)

- Pros: CI が速い。維持コストが最小
- Cons: パッケージ境界をまたぐ結合の壊れを構造的に検出できない。実際に起きた不具合群を再発防止できない

### Option B: UI アサーション中心の E2E

- Pros: 一般的で書きやすい。画面の退行を拾える
- Cons: DOM の見た目に依存するため flaky になりやすく、緑/赤の信号が信用されなくなる。何より**証明が検証を通るか**という本題を直接には測っていない

### Option C: 暗号成果物をオラクルにした round-trip E2E (全シナリオ full 検証)

- Pros: 「編集 → export → verify-cli の exit code」が判定なので、見た目に依存せず本題を直接測る
- Cons: PoSW full を全シナリオで回すと CI 時間が破綻する

### Option D: Option C + full は positive control 1 本に限定し、他は `--mode fast`

- Pros: C の利点を保ったまま CI 時間が収まる。full も 1 本は必ず通るので PoSW 経路が死んでいれば気づく
- Cons: fast のシナリオでは PoSW 再計算を検査しない。fast/full の使い分けを規約として維持する必要がある

## Decision

**Option D** を採り、その E2E を `deploy-preview` / `deploy-staging` / `deploy-production` の **必須ゲート** (`needs: [test, check, e2e]`) に置く。

具体的な線引き:

1. **オラクルは verify-cli の結論**。DOM の見た目ではなく、export した proof に対する verify-cli の exit code と `--analysis-json` で判定する
2. **負のオラクルを必ず対で持つ**。改竄・偽造・AI 一括投入・合成打鍵の各シナリオは verify-cli が **exit 1 で拒否する**ことを assert し、無改竄が pass する positive control と対にする。1 種でも素通りすれば「壊れた検証器」を緑と誤認するため
3. **合成打鍵は `page.evaluate(dispatchEvent)` で注入**する (`keyboard.type` では `isTrusted=true` になり ADR-0018 の検査を素通りしてしまう)
4. **full 検証は happy-path 1 本だけ**、他は既定で `--mode fast`。`workers: 2` の 2 並列、e2e job は `timeout-minutes: 30`
5. **持たないもの**: UI の見た目 assert、ユニットテストの再実装、proof 生成 / 検証ロジック本体 (それぞれ各パッケージの `__tests__` が担う)

## Consequences

### Positive

- パッケージ境界をまたぐ結合バグが CI で落ちるようになった (導入 PR 自体が root アンカー喪失・`insertParagraph` 検出漏れ・pure-typing 誤検知を発見して同時に修正している)
- 「検証器が改竄を素通しする」という最も危険な壊れ方に対し、負のオラクルが常時働く
- 不可逆な deploy の手前に、本題を直接測るゲートが立った

### Negative / Trade-offs

- CI 時間と維持コストを恒常的に負う (Playwright ブラウザの導入、CI 用の署名鍵 provisioning が要る)
- fast モードのシナリオは PoSW 再計算を検査していない。PoSW 側の退行は happy-path 1 本に依存する
- flake が出た場合の切り分けコストがユニットテストより高い (再発時は `workers: 1` に戻す運用)

### Follow-ups / 残課題

- 新しい spec を足すときは既定で `--mode fast` にすること。full を増やすなら CI 時間の再計測が要る
- E2E は Chromium のみ。他ブラウザでの記録系の差異は未カバー

## References

- [packages/e2e/CLAUDE.md](../../packages/e2e/CLAUDE.md) — 不変条件と罠 (本 ADR の運用面の正本)
- [.github/workflows/deploy.yml](../../.github/workflows/deploy.yml) — `e2e` job と `needs: [test, check, e2e]`
- `packages/e2e/tests/helpers/verifyCli.ts`, `packages/e2e/scripts/setup-env.mjs`
- [ADR-0018](0018-istrusted-capture.md) — 合成打鍵の扱い (負のシナリオの根拠)
- [ADR-0028](0028-tag-based-github-flow.md) — `v*` タグが production に直結するため、ゲートの重みが増している
- [ADR-0032](0032-biome-as-single-lint-format-toolchain.md) — もう一方の品質ゲート (lint / format)
