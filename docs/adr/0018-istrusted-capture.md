# ADR-0018: 合成打鍵を `isTrusted` で捕捉し advisory シグナル化する

- **Status**: Accepted
- **Date**: 2026-06-12
- **Deciders**: develop レビュー (Phase 7 / ADR-C)
- **PR / Commit**: `feat/phase7-session-anchor` (ADR-A と同ブランチに追補)

## Context

コードベースに `isTrusted` チェックが皆無だった (grep ゼロ)。ブラウザ拡張やページスクリプトが
`KeyboardEvent` を `dispatchEvent` で合成注入すると、エディタはそれを**通常のタイピングとして記録**して
しまう。`isTrusted` はユーザ操作由来の event が `true`、スクリプト dispatch 由来が `false` になる DOM 標準
プロパティで、合成入力の一класса (JS dispatch) を見分ける安価な手がかりになる。

ADR-0007 (記録/試験モードで捕捉する生信号を最大化) の実装範囲を一歩進める位置づけ。

## Considered Options

### 案A (採用): keystroke event の `data` に `isTrusted` を載せる (hashed・加算的)
- keyDown/keyUp イベントの `data` (`KeystrokeDynamicsData`) は **既に hash chain に焼かれている**。
  そこに `isTrusted` を足せば、**hash 機構を一切触らず**に改ざん耐性のあるシグナルになる。
- `isTrusted === false` の**ときだけ**フィールドを載せる → 信頼打鍵 (通常タイピング) の event data は
  従来とバイト一致 = hash 不変・完全後方互換・既存 proof/テストに無影響。
- 分析器 (`automationAnalyzer`, ADR-0009) が `isTrusted===false` の打鍵数を数えて advisory signal を出す。
- Pros: 改ざん耐性 (剥がせない) / hash 機構非変更 / 加算的 / honest 打鍵にゼロ影響。
- Cons: 部分的 (下記限界)。

### 案B (後続・難): Monaco モデル差分と trusted 打鍵ストリームの相関
- 「打鍵が無いのに content が変わった」(applyEdits/executeEdits/拡張) を相関で検出。
- Cons: IME (composition は 1:1 でない)・オートコンプリート・スニペット・ペーストで**誤検知**が多い。
  本 ADR では採らず、別 ADR の課題とする。

### 案C: `isTrusted` を非 hash の metadata として持つ
- Cons: hash されないため**剥がせる** (determined forger が proof から削除できる)。改ざん耐性を捨てるので却下。

## Decision

**案A**。keyDown/keyUp の `KeystrokeDynamicsData.isTrusted` に、合成打鍵 (`!e.isTrusted`) の**ときだけ**
`false` を載せる。`automationAnalyzer` が untrusted 打鍵数を数えて `severity:'review'` の advisory signal を出す。
判定はしない (ADR-0009 の advisory レイヤ)。proof フォーマットは**加算的**で bump 不要。

## Consequences

### Positive
- 拡張 / ページスクリプトによる合成打鍵 (JS dispatch) を、改ざん耐性のあるシグナルとして捕捉できる。
- hash 機構非変更・honest path にゼロ影響 (通常タイピングの event data はバイト一致)。

### Negative / Trade-offs
- **限界 (正直に)**: `isTrusted=false` は **JS dispatch のみ**。CDP `Input.dispatchKeyEvent` は
  **isTrusted=true**、ハードウェア注入 (物理デバイスエミュレータ等) も true → **捕捉できない**。
  つまり「untrusted 打鍵ゼロ」は「自動化なし」を意味しない。本シグナルは**部分的**で advisory。
- 完全捏造 proof は最初から untrusted 打鍵を記録しないので、これは「実エディタで動く拡張/スクリプト
  自動入力」を人間レビューに上げる用途であって、捏造の証明ではない。

### Follow-ups / 残課題
- paste/drop の `isTrusted` 捕捉 (本 ADR は keystroke のみ。paste は inputType で別途フラグ済み)。
- 案B (Monaco 差分 × trusted 打鍵相関) を IME/補完の誤検知に配慮して別 ADR で検討。

## References

- 実装: [`KeystrokeTracker.ts`](../../packages/editor/src/tracking/KeystrokeTracker.ts) (`handleKeyDown`/`handleKeyUp`)、
  [`types/events.ts`](../../packages/shared/src/types/events.ts) `KeystrokeDynamicsData.isTrusted`、
  [`automationAnalyzer.ts`](../../packages/shared/src/analysis/analyzers/automationAnalyzer.ts)
- 関連 ADR: [ADR-0007](0007-maximal-signal-capture.md) (生信号捕捉。本 ADR が実装範囲を前進)、[ADR-0009](0009-pluggable-analysis-layer.md) (advisory 分析層)
- テスト: `automationAnalyzer.test.ts` / `KeystrokeTracker.test.ts`
