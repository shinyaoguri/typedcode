# ADR-0039: カバレッジの床は機能 PR で動かさず、週 1 回の定期ジョブの知らせを受けた専用の PR で上げる

- **Status**: Accepted
- **Date**: 2026-11-03
- **Deciders**: @shinyaoguri
- **PR / Commit**: (#472 を閉じる PR)

## Context

[ADR-0034](0034-replace-manual-verification-with-automated-tests.md) の決定 4 は、カバレッジの床 (各 `packages/*/vitest.config.ts` の `coverage.thresholds`) を実測値の切り捨てで固定し、「テストを足してカバレッジが上がったら、その PR の作者が `npm run coverage:ratchet` で床を引き上げ、差分もコミットする」とした。この運用で次の 2 つが起きた。

- **手元の実測で上げた床を CI の実測が割る**: PR #463 で、手元の `coverage:ratchet` が editor の branches の床を 20 に上げたが、CI の test job の実測は 19.99% で床割れになった。ラチェットは実測の切り捨てなので、手元 20.0x / CI 19.99 のような小さなずれで落ちる。同じソースの CI でも 19.99% と 20.02% に揺れることがあり (揺れの原因の特定は #495)、手元で決めた床が CI で通る保証は無い。作者は CI を見るまで気付けず、修正コミットが 1 本増えた
- **並行する PR が同じ行で衝突する**: 並行する機能 PR がそれぞれラチェットすると、`vitest.config.ts` の同じ `thresholds` の行を書き換えるので毎回衝突する (同じ一括着手で 5 本が衝突した)

実際の運用は、既にマージ後にまとめてラチェットする形 (#438・#473・#488) に外れていた。

## Considered Options

### Option A: 現状どおり、機能 PR の作者がラチェットする

- Pros: 床がすぐ上がり、カバレッジの低下を検出する精度が最も高い
- Cons: 上記の床割れと衝突が続く。手元と CI の実測のずれは作者には制御できない

### Option B: 床に余裕 (例: 実測 − 0.5%) を持たせてラチェットする

- Pros: 手元と CI のずれによる床割れは減る
- Cons: 並行 PR の衝突は残る。余裕の分だけ低下を見逃す。余裕の幅に根拠が無い

### Option C: main で定期的にラチェットし、PR まで自動で開く

- Pros: 人の手が要らない
- Cons: `GITHUB_TOKEN` で開いた PR には pull_request の CI が走らないため、GitHub App か PAT を作って登録する運用が要る。その秘密の管理コストに見合わない

### Option D: 機能 PR では床を動かさない。main で週 1 回ラチェットを試し、上げられる値を Issue で知らせ、それを見た人かエージェントが専用の PR で床を上げる

- Pros: 床を上げる PR の CI (test job) が、CI 上の実測で床を超えていることをそのまま確かめる (手元のずれに依存しない)。機能 PR が `vitest.config.ts` を触らないので衝突しない。既に外れていた実際の運用と一致する。秘密の追加が要らない
- Cons: 床が上がるまで最長で 1 週間 (と知らせを処理するまで) 遅れ、その間の小さな低下は検出しない。知らせを処理する手間が週に一度かかる

## Decision

**Option D** を採る。ADR-0034 の決定 4 のうち「上げたら `npm run coverage:ratchet` で床を引き上げる」の運用を、次のとおり改める (床を実測値の切り捨てで固定し、下回ると test job が落ちることは変えない)。

1. 機能 PR では `coverage.thresholds` を動かさない。`npm run coverage:ratchet` は床を上げるための専用の PR でだけ回す
2. 週 1 回 (と `workflow_dispatch`)、main で `npm run coverage:ratchet` を回す定期ジョブを置く。差分が出たら、パッケージと指標ごとの「今の床 → 上げられる値」を Issue に書く (同じタイトルの open Issue があればコメントを追記する)。差分が無ければ何もしない。下がる向きの差分は上げられる値として扱わない
3. 判定と本文の組み立ては `scripts/*.mjs` の純関数に置き、`node --test` でテストする。ワークフローの権限は `contents: read` と `issues: write` だけで、PR は開かない
4. 床を上げる PR は、知らせを見た人かエージェントが出す。その PR の test job が緑であることが、CI 上の実測で床を超えていることの確認になる

## Consequences

### Positive

- 手元と CI の実測のずれで機能 PR の test job が落ちなくなる
- 並行する機能 PR が `vitest.config.ts` の同じ行で衝突しなくなる
- 床を上げる操作が専用の PR に集まり、何がどれだけ上がったかが追える

### Negative / Trade-offs

- 床が上がるまでの間 (最長 1 週間 + 処理待ち) は、上がったカバレッジが少し下がっても検出しない
- 知らせの Issue を処理する手間が定期的にかかる。放置すると床が実測から離れていく

### Follow-ups / 残課題

- 同じソースで CI の実測が揺れる原因の特定と測定の決定化 (#495)

## References

- [ADR-0034](0034-replace-manual-verification-with-automated-tests.md) — 決定 4 (カバレッジのラチェット) を本 ADR で改訂
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — 「カバレッジは下げない」
- Issue #472 / #463 (床割れ) / #495 (実測の揺れ) / #438・#473・#488 (マージ後のまとめたラチェット)
