# ADR-0020: 保証を三層語彙 (整合性 × 時刻アンカー × 著述性) で機械導出し表示する

- **Status**: Accepted
- **Date**: 2026-06-12
- **Deciders**: (PR 上の合意者 / レビュアー)
- **PR / Commit**: (本 ADR と同一 PR)

## Context

TypedCode の proof は強度の異なる複数の保証を束ねているが、検証 UI / CLI はそれを単一の
PASS/FAIL (+ 信頼バッジ verified/partial/failed) に圧縮して見せている。これは 2 つの誤読を生む:

1. **過剰主張 (overclaim)**: 「検証 PASSED」を見た教員が「AI 不使用のお墨付き」と読む。実際に
   暗号が保証するのは「記録の完全性と時刻」であって「著述の人間性」ではない (後者は原理的に
   advisory、ADR-0009)。誤読のまま運用されると、誤検知が学生への冤罪に、検知漏れが制度への
   過信になる。
2. **過小主張**: 警告 1 件で `partial` に落ちる現行バッジは、「チェーンは数学的に無傷」という
   強い事実を弱い表示に巻き込む。

また ADR-0011 §6 は「保証ラベルは自己申告 `mode` でなく**実証拠から機械判定**できるようにする」
を宿題として残しており、これが未実装だった。

## Considered Options

### Option A: 現行の単一バッジを維持し、説明文で補う
- Pros: 実装ゼロ。
- Cons: 圧縮こそが誤読の原因。説明文は読まれない。→ 却下

### Option B: 保証を独立した三層の語彙として導出・表示する ★採用
- **整合性 (integrity)**: 記録は事後改変されていないか。暗号検証、決定的、二値 (proven/failed)。
- **時刻アンカー (temporal)**: 記録はいつ存在したか。サーバ署名 (root アンカー ADR-0017 +
  署名 cp ADR-0002/0016) による決定的判定。anchored / partial / unanchored。試験 proof は
  T0 束縛 (封印 + 監督コード = proctor) が時刻 regime を担うため独立値 `exam-t0`。
- **著述性 (provenance)**: 打鍵が転写でなく著述に見えるか。**常に advisory** でレベルを持たない
  (pureTyping + 分析シグナル数 + 要確認度の事実併記のみ)。ADR-0009 の直交性を表示語彙にまで
  延長する。
- Pros: 各層の強度差が一目で伝わる。advisory が verdict に化ける余地を構造的に塞ぐ。
- Cons: UI が 1 バッジ → 3 バッジに増える。

### Option C: スコアリング (重み付き合成点)
- Cons: 合成した瞬間に「advisory が判定に混入する」。重みの根拠も示せない。→ 却下

## Decision

Option B を採用。

1. **導出は shared の純関数** `deriveAssurance(AssuranceInput): AssuranceResult`
   (`packages/shared/src/assurance.ts`)。verify (web) と verify-cli が同一実装を使い、
   「Web と CLI で保証表示が食い違う」事故を構造的に防ぐ。テストは shared に置く。
2. **入力は実証拠のみ**: metadataValid / chainValid / スクショ改竄数 / exam 束縛 /
   rootAnchored / 署名 cp (valid・sparse・postHoc) / isPureTyping / 分析サマリ。
   **自己申告 `proof.mode` は入力に使わない** (ADR-0011 §6)。mode は「自己申告」と明記の上で
   参考表示のみ。
3. **温度差の規律**:
   - integrity と temporal は決定的入力のみから導出する。
   - provenance はどんな値でも integrity / temporal に影響しない (テストで固定)。
   - 本導出は `verifyProofFile` の valid を**置き換えない** (表示語彙であって判定ではない)。
4. **temporal の導出規則**:
   - exam present → `exam-t0` (署名 cp は best-effort の補強で regime を変えない)
   - rootAnchored ∧ 署名 cp が valid・密・post-hoc 疑いなし → `anchored`
   - rootAnchored ∨ 有効な署名 cp (ただし疎 / post-hoc / 片方のみ) → `partial`
   - どちらも無し (invalid な cp 連鎖は時刻証拠に数えない) → `unanchored`
5. **表示**: verify (web) は結果画面最上部に三層バッジ (+ mode の参考表示)、verify-cli は
   ヘッダ直下に `--- Assurance ---` 1 行サマリ。既存の TrustCalculator (issue リスト) と
   タブ status は詳細パネルとして併存する (issue の母集団は変えない)。
6. **文言の是正**: README / system-spec の「人間がキー打鍵で順番に入力した」级の表現を、
   本語彙に整合する精密な主張 (「このエディタ内で・この時間窓に・この編集列で構築され、
   事後改変されていない」+ 著述性は参考情報) に改める。

## Consequences

### Positive

- 採点者が「何がどの強さで保証されているか」を 1 画面で誤読なく読める。overclaim の構造的抑止。
- ADR-0011 §6 (実証拠からの保証導出) を消化。低保証 proof が表示上「上に化ける」余地がない。
- Web / CLI の保証表示が単一実装に揃う。
- ADR-0009 の「advisory を判定にしない」が表示レイヤまで貫通する。

### Negative / Trade-offs

- バッジが増え UI が賑やかになる (3 つに限定し、詳細は既存 issue パネルへ委譲して緩和)。
- temporal の `partial` は複数要因 (疎 / post-hoc / 片側のみ) を 1 語に畳む。詳細は
  既存の Anchoring カードが補う。
- 既存の TrustCalculator と二重構造になる (役割分担: 三層 = 最上部の語彙、TrustCalculator =
  個別 issue の列挙。将来 TrustCalculator の level を三層から導出する統合は別途検討)。

### Follow-ups / 残課題

- ProcessSummary (Phase 8 W3) と並ぶ「最上部 1 画面」の情報設計の調整。
- TrustCalculator level と三層語彙の統合 (重複の解消) — 実運用の様子を見て。
- エクスポート README (提出 ZIP 同梱) にも三層の説明を載せるか — 別途。

## References

- [ADR-0009](0009-pluggable-analysis-layer.md) — 分析は advisory・判定しない (本 ADR はその表示への延長)
- [ADR-0011](0011-course-modes-and-path-routing.md) — §6 保証ラベルの機械判定 (本 ADR が消化)
- [ADR-0016](0016-anchoring-density-signal.md) / [ADR-0017](0017-server-anchored-chain-root.md) — temporal 層の入力
- [ADR-0006](0006-exam-mode-sealed-problem-binding.md) — exam の T0 regime
- `packages/shared/src/assurance.ts` — 導出の実装 (単一ソース)
