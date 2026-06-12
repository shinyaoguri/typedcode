# ADR-0022: 提出前セルフレビューと振り返りノート (reflectionNote)

- **Status**: Accepted
- **Date**: 2026-06-12
- **Deciders**: (PR 上の合意者 / レビュアー)
- **PR / Commit**: (本 ADR と同一 PR)

## Context

プロセス記録は現状、採点者だけが見る「監視の産物」になっている。process-first 路線
(Phase 8) の核心は**過程そのものを第一級の提出物にする**ことであり、そのためには:

1. **学生が自分の過程を先に見る** — ツールの性格を監視から「鏡」(自己省察の道具) へ変え、
   導入の心理的障壁を下げる。提出物に何が含まれるかを本人が提出前に把握する (透明性)。
2. **本人の声を過程に残す** — 工夫・詰まった点・参照したものの自己申告は採点・指導の
   一次資料になり、口頭試問の接続点にもなる (述べたことを後から説明できるか)。

## Considered Options

### Option A: ノートを ZIP 内の別ファイル (proof 外) に置く
- Cons: チェーン外なので後から差し替え可能。「提出時に本人がそう述べた」ことを
  採点者が信頼できない。→ 却下

### Option B: reflectionNote イベントとしてチェーンに記録する ★採用
- 新イベント型 `reflectionNote` (data: `{ text }`) を export 直前に記録。
  チェーンに焼かれるため改ざん検出つきで、最終 checkpoint / 署名 cp にも覆われる。
- Pros: 「本人が提出時に何を述べたか」が暗号的に固定される。
- Cons: 新イベント型の追加 (下記の互換性検討)。

## Decision

Option B を採用。

1. **新イベント型 `reflectionNote`** (`ReflectionNoteData { text: string }`)。空文字は
   記録しない (イベント自体を作らない)。
2. **互換性**: 検証経路は未知イベント型を拒否しない (確認済み: チェーンハッシュは型非依存・
   `verifyProofMetadata` の再カウントは inputType 基準・content replay は対象 3 型のみ・
   `validateEventType` は検証経路で未使用・バージョン上限チェックなし)。よって
   **`PROOF_FORMAT_VERSION` は 1.2.0 据え置き** (加算的)。
3. **UI**: export 開始時 (チェーン完了待ちより前) に `SelfReviewDialog` を表示。
   `ProcessSummary` (W3 と同一の抽出器 = 採点者が見るものと同じ要約) + 任意の
   ノート欄。**スキップ可・キャンセルで export 中止可**。一括 export では 1 回だけ
   表示し、ノートはアクティブタブのチェーンへ記録する (タブ毎 N 回は摩擦過多)。
4. **能力トグル `selfReview`** (ADR-0011 のプリセット): casual/class/assignment = on、
   **exam = off** (試験の時間圧迫を避ける。フォーマットは共通なので将来出題者判断で
   有効化可能)。
5. **表示**: `summarizeProcess` が `reflectionNotes` として抽出し、verify の
   プロセス要約カードに「本人の振り返り (提出時に記録)」、CLI に `Reflection:` 行。
   中立表示 (内容の真偽は採点者・口頭試問が判断する自己申告)。

## Consequences

### Positive

- 学生が提出前に「採点者が見るものと同じ要約」を見る — 透明性と自己省察 (メタ認知) の装置。
- 振り返りが改ざん検出つきの一次資料になり、採点・指導・口頭試問の材料になる。
- proof フォーマット非破壊・旧 verifier 互換 (検証済み)。

### Negative / Trade-offs

- export に 1 ステップ追加 (スキップ可・exam では出さないことで緩和)。
- ノートは自己申告であり真正性の保証はない (「提出時にそう述べた」ことだけが保証される)。
- 旧 verify ビルドはノートを専用表示しない (イベントログには出る。検証は壊れない)。

### Follow-ups / 残課題

- エディタ内ミニ再生 (W4-B): セルフビューに自分のリプレイを足す — 価値検証後。
- LogViewer の reflectionNote 表示 (表示のみ)。
- 振り返りプロンプトの教育設計 (何を問うと省察が深まるか) — 運用知見待ち。

## References

- [ADR-0011](0011-course-modes-and-path-routing.md) — 能力プリセット (selfReview トグルの置き場)
- [ADR-0009](0009-pluggable-analysis-layer.md) / [ADR-0020](0020-three-layer-assurance-vocabulary.md) — 自己申告を判定に使わない既存原則
- `packages/editor/src/ui/components/SelfReviewDialog.ts` — UI
- `packages/editor/src/export/ProofExporter.ts` — フック (`performSelfReview`)
- `packages/shared/src/processSummary.ts` — `reflectionNotes` 抽出
