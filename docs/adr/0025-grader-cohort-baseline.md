# ADR-0025: 採点者向けコホート基準を content-free な分布として定義する (外れ値は triage であって違反ではない)

- **Status**: Accepted
- **Date**: 2026-06-12
- **Deciders**: (PR 上の合意者 / レビュアー)
- **PR / Commit**: develop へ stacked-PR

> 1 件の `ProcessSummary` / `AnalysisReport` は単独では解釈しづらい。「45 分は速いのか遅いのか」「削除率 3% は普通か」は**コホート (そのクラス・その課題) の分布**に対してしか意味を持たない。採点者は提出物が**集団のどこに位置するか**を見て注意配分したい — **自動判定のためではなく**。本 ADR は、コホート基準の**モデルと不変条件**を定める (実装は follow-up)。ADR-0024 の Tier A/S を入力前提にする。

## Context

- 単体メトリクスは基準がないと読めない。`durationMs` / `deletionRatio` / `pauseCount` / `reviewPriority` 等は、**同一課題の他提出**との相対でしか「外れている」と言えない。
- 採点者の実務は「全 N 件を均等に精査」する余裕がない。**どこに目を向けるかの triage** が要る。コホート分布における外れ値は、その triage の自然な手掛かり。
- ただし強い制約 (既存 ADR と整合させる):
  - **外れ値 ≠ 違反** (ADR-0009 直交性 / ADR-0023 非判定)。速い人・手戻りの少ない人・IME や支援技術の利用者は正当に外れ得る。コホート位置は**記述的**であって規範ではない。
  - **我々は基準 (norms) を配らない** (ADR-0023)。打鍵分布は文脈依存で、我々が「期待分布」を焼くと誤った権威づけ。基準は**採点者が自分のコホートから**作る。
  - **content-free で作れること** (ADR-0024)。分布計算に学生のソースは不要 — `ProcessSummary` / `AnalysisReport` の数値メトリクス (Tier A) で足りる。
  - **コホート内のプライバシー**。ある学生を集団と比較する際、他学生の識別可能データを漏らしてはならない。基準は**集約統計のみ**を保持する。
  - **公平性**。小さい/非代表なコホート、IME・支援技術・タイピング速度の多様性は外れ値を生む。基準は ★6b 配慮と併せて解釈する。

## Considered Options

### Option A: 我々が「期待される」コホート基準/norms を同梱する
- Pros: 採点者は何もせず比較できる。
- Cons: 非代表な基準を焼く = 誤った権威づけ (ADR-0023 違反)。母集団が違えば無意味。多様性 (IME/速度/支援技術) を「異常」に見せる。→ **却下**。

### Option B: コホート道具を提供しない (各採点者が場当たりで集計)
- Pros: 最小。
- Cons: 場当たり集計はソース露出 (Tier 越境) や不統一な統計を招く。プライバシー保証も各自任せ。基盤 (ADR-0023) としての価値を捨てる。→ **却下**。

### Option C: content-free なコホート基準**プリミティブ** + 提出物の位置ビューを advisory で提供。コホートは採点者が用意する (本 ADR)
- 入力: 採点者自身のコホートの **Tier A アーティファクト群** (content-free な `ProcessSummary` + `AnalysisReport`)。
- 基準 (Baseline): メトリクスごとの**頑健な分布要約** (件数・中央値・四分位/IQR、必要なら平均/SD) + 各分析次元の **base rate** (signal が出た割合)。**個票は保持しない** (集約のみ)。
- 位置 (Position): 1 提出のメトリクスが各分布のどこか (パーセンタイル / IQR 位置 / z 相当) + どの次元がコホート base rate に対して目立つか。**advisory な triage** として提示し、過程リプレイへリンク。
- Pros: 統一・プライバシー尊重・「怪しさ」を**実際の局所分布**に接地・Tier A / eval 基盤を再利用・我々は norms を持たない。
- Cons: コホート偏りリスク・advisory 止まり・採点者がコホートを集める手間・小 N で不安定。→ **採用**。

## Decision

**Option C** を採る。コホート基準は「我々が配る規範」ではなく「**採点者が自分の Tier A データから作る、content-free な集約分布**」。提出物の位置は**注意配分の手掛かり (triage)** であって、判定でも違反の証拠でもない。

### モデル

- **入力**: コホート = 同一課題の Tier A アーティペクト集合 `{ ProcessSummary, AnalysisReport }[]` (ADR-0024、ソース・fingerprint を含まない)。
- **対象メトリクス (content-free・数値)**: `durationMs`, `contentChangeCount`, `insertedChars`, `deletedChars`, `deletionRatio`, `executionCount`, `runSuccessCount`, `runFailureCount`, `pauseCount`, `longestPauseMs`, `focusLossCount`, `externalInputCount`, `reviewPriority`、および各 `AnalysisDimension` の **signal 有無 (base rate)**。
- **Baseline**: 上記メトリクスごとに `{ n, median, q1, q3, iqr, min, max }` (頑健統計を主とする)。次元ごとに `{ signalRate }`。**個票・識別子は保持しない**。
- **Position(submission, baseline)**: メトリクスごとに `{ value, percentile, iqrPosition }` (例: "IQR 上限の 3 倍" "上位 2%")。次元ごとに「コホート base rate に対して出た/出ない」。すべて advisory。

### 不変条件 / ルール

1. **advisory のみ。** 外れ値は triage の手掛かりであって違反ではない。`valid` / exit code に**一切反映しない** (ADR-0009/0023)。
2. **content-free な Tier A から作る** (ADR-0024)。ソース不要。Baseline は**集約のみ**を保持し、他学生の識別可能データを露出しない。
3. **我々は基準を配らない** (ADR-0023)。採点者が自分のコホートから計算する。同梱するのは**計算プリミティブと表示**だけで、norms や閾値ではない。
4. **記述的であって規範ではない。** 「コホートと違う」は欠陥を意味しない。IME・支援技術・速度の多様性は正当な外れ値 — ★6b 配慮と併せて解釈する (位置表示にこの注意書きを添える)。
5. **頑健統計と小 N ガード。** 過程メトリクスは歪んだ分布で小 N に弱い → 中央値/IQR を主とし、`n` を常に併記、**閾値以下のコホートでは percentile を出さない/警告する**。
6. **コホート代表性の明示。** 混在母集団・極小クラスでは基準が誤導する旨を表示する (overclaim 防止・ADR-0020 の精神)。

## Consequences

### Positive
- 「怪しさ」を抽象な絶対基準ではなく**実際の局所分布**に接地し、採点者の注意配分を統一的・プライバシー尊重で支援。
- Tier A (ADR-0024) と eval 基盤 (W5) を再利用 — 新規の重い構造は不要。我々は norms を持たない (ADR-0023 整合)。

### Negative / Trade-offs
- コホート偏り (非代表・小 N・混在) のリスク。頑健統計と N 警告で緩和するが消えはしない。
- advisory 止まり — 位置は判定ではない。誤読 (外れ値=クロ) を運用と表示で防ぐ責任。
- 採点者がコホート (Tier A 群) を集める前提。単発提出には基準が無い。

### Follow-ups / 残課題
- shared 純粋関数の実装: `computeCohortBaseline(summaries) -> CohortBaseline`、`positionInCohort(summary, baseline) -> CohortPosition` (eval の `evaluateAnalysis` と同型の content-free 集計)。
- 表示/CLI 面: verify のコホートビュー、verify-cli の集計出力 (`--analysis-json` + ProcessSummary を束ねた Tier A 群を食う)。
- ★6b 支援技術・IME 配慮 docs と相互参照 (外れ値の公平な解釈)。
- Tier A エクスポート (ADR-0024 follow-up) が入力フォーマットの前提。

## References

- ADR-0024 (データ最小化ティア: Tier A が本基準の入力)
- ADR-0023 (非判定・我々は norms を配らない)
- ADR-0009 (分析の直交性・advisory)
- ADR-0020 (overclaim を避ける表示)
- `packages/shared/src/processSummary.ts` (`ProcessSummary` の content-free メトリクス)
- `packages/shared/src/analysis/eval.ts` (`evaluateAnalysis` — 同型の content-free 集計の先例)
- docs/analysis-eval-protocol.md (コホートでの評価の運用)
