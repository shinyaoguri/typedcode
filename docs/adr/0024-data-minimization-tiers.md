# ADR-0024: 目的別データ最小化ティアを定義する (整合性は全イベント・分析/共有は content-free 派生物)

- **Status**: Accepted
- **Date**: 2026-06-12
- **Deciders**: (PR 上の合意者 / レビュアー)
- **PR / Commit**: develop へ stacked-PR

> 検証の整合性は**全イベントを要求**する (ハッシュチェーンが全打鍵を束ねる) が、その全イベント列には**学生のソース全文と打鍵動態・フィンガープリント**が含まれる。これを分析者・研究者・コホート集計など**あらゆる消費者に丸ごと渡すのは過剰露出**。データ最小化 ([[analysis-platform-stance]] ADR-0023 / 評価プロトコル §2 / [[review-develop-2026-06]] のデータ最小化指摘) と整合性を両立させる**ティアモデル**を定める。本 ADR は方針・不変条件・ティア定義を確定し、実装と「検証可能な選択的開示」の暗号は follow-up に委ねる。

## Context

事実関係 (`packages/shared/src/types/proof.ts`):

- **ハッシュチェーン = `SHA256(h_{i-1} ‖ JSON(event_i) ‖ PoSW_i)`** ([[phase8-plan]] / shared 不変条件 #1)。各 `StoredEvent` は `data` / `insertedText` / `selectedText` に**打鍵した文字そのもの**を持つ。
- したがって**整合性検証 (`verifyProofFile`) には全イベント列が必須**。1 つでも削る・テキストを伏せると `JSON(event_i)` が変わりチェーンが壊れる。**proof は redact できない**。
- proof にはさらに `content` (最終全文)、`fingerprint.components` (canvas/webgl/fonts 等の**端末識別情報**) が入る。
- 一方、既存の派生物は **content-free**:
  - `ProcessSummary` (Phase 8 W3): 挿入/削除数・実行・停止・離脱・見どころの **event index** を持つが**ソース文字は持たない**。例外は `reflectionNotes` (学生が採点者向けに書いた振り返り = ソースとは別クラスの、意図的に共有する自己申告)。
  - `AnalysisReport` (ADR-0009): signal + 証拠 (event index) + サマリ。**ソース文字を含まない**。
  - `AssuranceResult` (ADR-0020): 三層保証。content-free。

問題: 整合性のために proof は丸ごと必要だが、その丸ごとを**全消費者に配ると過剰**。「採点者がソースを見る」のと「研究者が分布を見る」「ダッシュボードが集計を見る」は**必要なデータ粒度が違う**。proof を redact できない以上、最小化は**消費者目的ごとの派生物**で実現するしかない。

## Considered Options

### Option A: 常に full proof を全消費者へ
- Pros: 単純・派生物の管理不要。整合性は誰でも検証できる。
- Cons: ソース全文・打鍵動態・端末 fingerprint を分析者/研究者/集計にまで露出。ADR-0023 (研究基盤は content なしで分析できる) / 評価プロトコル §2 (content を伏せても分析は動く) / データ最小化原則に反する。→ **却下**。

### Option B: 検証可能な選択的開示を今やる (content コミットメント + Merkle reveal)
- チェーンに**ソースの平文ではなくコミットメント**を焼き、平文は別添で必要時のみ reveal。redact しても独立に整合性検証できる redacted proof を作る。
- Pros: 「最小化された proof が単独で検証可能」という理想形。
- Cons: 暗号設計が重い (コミットメント方式・reveal プロトコル・チェーン式変更)。**`PROOF_FORMAT_VERSION` 破壊的変更**。現状の過剰露出を解くには過大。今要らない。→ **却下 (将来 ADR として残す)**。

### Option C: 全体は不変のまま、目的別の派生ティアで最小化する (本 ADR)
- **canonical proof は丸ごと**のまま、整合性検証を担う**信頼された相手**にだけ渡す。
- それより広い共有は **content-free な派生物** (`ProcessSummary` + `AnalysisReport` + `AssuranceResult`) で行う。これらは単独では整合性検証できない (= 派生ビュー) が、ソース・端末情報を含まない。
- 「検証可能な redaction」(Option B の暗号) は**将来パス**として記録し、今は作らない。
- Pros: 過剰露出を解く・ADR-0023 と整合・整合性アーティファクトを一切弱めない・既存の content-free 派生物を素直に活かせる。
- Cons: 派生ティアは advisory で**単独では整合性検証不能** (信頼境界 or full proof との突合が要る)。真の検証可能 redaction は Option B 待ち。→ **採用**。

## Decision

**Option C** を採る。データ最小化は **proof の改変ではなく、消費者目的ごとの派生ティア**で実現する。

### ティア定義 (目的 → 必要粒度 → 想定読者)

| ティア | 中身 | 用途 | 想定読者 | 整合性検証 |
|---|---|---|---|---|
| **Tier F (Full proof)** | 全イベント列 + `content` + `fingerprint` + checkpoints / sessionStartToken / exam ブロック | 整合性検証・ソース採点・完全リプレイ | 整合性を検証する**信頼された相手** (担当教員 / autograder) | **可能** (canonical) |
| **Tier A (Analysis view, content-free)** | `ProcessSummary` (`reflectionNotes` 含む) + `AnalysisReport` + `AssuranceResult` | 過程の分析・コホート基準・研究 | 分析者 / 研究者 / コホート集計 (ソースを見るべきでない相手) | 不可 (派生・要信頼境界) |
| **Tier S (Summary, aggregate)** | `AssuranceResult` + headline 統計 + `reviewPriority` (event index 抜き) | ダッシュボード・集計 | 集計・俯瞰 | 不可 (派生) |

### 不変条件 / ルール

1. **データ最小化は整合性アーティファクトを決して弱めない。** チェーン (全イベント) は redact しない。Tier F は常に丸ごと。
2. **ティアは proof の改変ではなく派生ビュー。** 最小化のために proof を書き換えない。
3. **同梱 (in-tree) の分析はソース平文なしで導出可能でなければならない** (ADR-0009/0023)。新しい既定アナライザは Tier A の粒度 (event 列のメタデータ = type/inputType/timing/index) で機能すること。**ソース文字に依存する分析は採点者の private ティア**に置く (配布しない = evasion 耐性)。
4. **`reflectionNotes` はソースとは別の感度クラス。** 学生が採点者向けに意図的に書いた自己申告であり Tier A に含めてよい (ソース開示とは別判断)。
5. **fingerprint は端末識別情報なので Tier F 限定。** Tier A/S に fingerprint コンポーネントを載せない。
6. **信頼境界の明示。** Tier A/S は単独で整合性検証できない以上、「これは検証された proof から派生した advisory ビューであり、整合性は Tier F で別途検証される」ことを生成・表示時に明記する (overclaim 防止・ADR-0020 の精神)。

## Consequences

### Positive
- ソース全文・打鍵動態・fingerprint の露出を「整合性を検証する相手」に限定でき、分析/研究/集計は content-free で回る (ADR-0023 の研究基盤方針と直結)。
- 整合性アーティファクト (Tier F) を一切弱めない。既存の `ProcessSummary`/`AnalysisReport`/`AssuranceResult` がそのまま Tier A/S の構成要素になる (新規構造ほぼ不要)。
- 採点運用の同意・保管方針が明確化 (full proof は授権相手のみ・広い共有は content-free)。

### Negative / Trade-offs
- Tier A/S は **advisory かつ単独で整合性検証不能**。「派生ビューを信頼してよいか」は信頼境界 (誰が派生させたか) or Tier F との突合に依存する。真の検証可能 redaction は未提供。
- 「分析はソース平文なしで導出可能」ルールが、将来のソース依存分析 (例: コメントと実装の不整合) を**同梱では**縛る (private ティア送り)。これは意図した制約。

### Follow-ups / 残課題
- **Tier A エクスポートの実装** (editor / verify-cli): events/content/fingerprint を除いた `{ProcessSummary, AnalysisReport, AssuranceResult}` バンドルを出す口。`--analysis-json` (ADR-0009) は既にその一部 (AnalysisReport) を出している → ProcessSummary/assurance も束ねた "analysis bundle" へ拡張する候補。
- **検証可能な選択的開示 (Option B)** が必要になったら独立 ADR で: content コミットメント方式 + reveal プロトコル + `PROOF_FORMAT_VERSION` 設計。
- **★5 grader ベースライン/コホート ADR** は本ティア (Tier A/S の集計) を入力前提に設計する。
- fingerprint 自体の最小化 (Tier F 内でも採点に不要なコンポーネントを削るか) は別途検討余地。

## References

- ADR-0023 (分析プラットフォーム方針: 研究基盤は content なしで分析する)
- ADR-0009 (分析層の直交性・private 分析器)
- ADR-0020 (三層保証語彙: 派生ビューの overclaim を避ける)
- shared 不変条件 #1 (ハッシュチェーン = 全イベント・redact 不可) — `packages/shared/CLAUDE.md`
- `packages/shared/src/types/proof.ts` (`ExportedProof` / `StoredEvent` の content・fingerprint)
- `packages/shared/src/processSummary.ts` (`ProcessSummary` / `reflectionNotes`)
- `docs/analysis-eval-protocol.md` §2 (データ最小化・同意)
