# ADR-0005: 許可/禁止 InputType の方針

- **Status**: Accepted
- **Date**: 2026-05-21

## Context

`TypingProof` は `InputType` (W3C InputEvent の `inputType` 値) ごとに「タイピング証明として許容するか」を判定する。許可リストと禁止リストの境界が不明瞭だと、

- 「コピペしてないのに ピュアタイピング 判定 NG」になり UX が悪化
- 逆に「外部入力なのに通る」と証明の意味が消える

の両方が起き得る。明文化が必要。

過去に取り違えがあった例:
- `insertTab` を禁止と誤分類していた → タブ入力が NG に
- `insertFromInternalPaste` (自分の typed コードを copy & paste) を禁止と誤分類 → 通常作業が阻害された
- `deleteByCut` (Ctrl+X) を未分類 → 編集操作の正規ルートが許可リストに入っていなかった

## Considered Options

### Option A: 入力を全部許可、後で統計判定
- Pros: UX 最大化
- Cons: 証明の信頼性が下がる、ペーストを通常入力と区別できなくなる

### Option B: ホワイトリスト方式 (許可されたものだけ通す) ← 採用
- Pros: 明示的、安全側に倒れる、判定が決定的
- Cons: 新しい入力タイプが出るたびにレビューが必要

### Option C: ブラックリスト方式 (禁止されたもの以外通す)
- Pros: ホワイトリスト更新の手間が小さい
- Cons: 知らない入力タイプが追加されたとき素通りする (将来の W3C 仕様変更で証明が崩れる)

## Decision

**Option B (ホワイトリスト) を採用**。`InputTypeValidator.ts` に **明示的な許可リスト / 禁止リスト** を持ち、未知の入力タイプは禁止扱いにする。

### 許可リスト (20 種類)
通常のキーボード編集、合成入力 (IME)、削除操作、Undo/Redo、**自セッション内のコピー&ペースト** (`insertFromInternalPaste`)、タブ挿入 (`insertTab`)、Cut (`deleteByCut`)、ドラッグでの削除 (`deleteByDrag`)。

### 禁止リスト (5 種類) — 外部入力
`insertFromPaste`, `insertFromDrop`, `insertFromYank`, `insertReplacementText`, `insertFromPasteAsQuotation`。これらが含まれると **ピュアタイピング判定が NG**。

### その他 (1 種類)
`replaceContent` — 内部的なコンテンツ置換。許可/禁止の文脈ではなく扱う。

### 内部ペースト判定
ペーストイベントが来たら `SessionContentRegistry` と照合:
- 一致 → `insertFromInternalPaste` (許可)
- 不一致 → `insertFromPaste` (禁止)

これにより「自分が書いたコードを別タブにコピー&ペースト」のような正当な操作はピュアタイピング判定を破らない。

## Consequences

### Positive
- 判定が決定的かつ明示的
- 新規入力タイプは「知らないので禁止扱い」で安全側に倒れる
- ユーザーの正当な操作 (Tab, Cut, 自セッション内コピー) は通る

### Negative / Trade-offs
- 新しい W3C InputEvent タイプが出るたびにメンテが必要
- `SessionContentRegistry` の管理コスト (内部ペースト判定のため)
- ホワイトリストの 20 種類が「直感的」ではないものもある (`deleteCompositionText` 等)。コメントで意図を残す必要あり

### Follow-ups / 残課題
- 新 InputType 検討時はこの ADR に追記しない (append-only)。代わりに新 ADR を切る (例: ADR-NNNN "Allow `insertFooBar`")
- 将来、入力タイプごとに「許可だが警告」のような中間状態を導入する場合は別 ADR で

## References

- 実装: [`packages/shared/src/typingProof/InputTypeValidator.ts`](../../packages/shared/src/typingProof/InputTypeValidator.ts)
- 型: [`packages/shared/src/types/events.ts`](../../packages/shared/src/types/events.ts)
- 内部ペースト: [`packages/editor/src/services/`](../../packages/editor/src/services/) (SessionContentRegistry)
- 検証: ピュアタイピング判定は `verifyProofFile` 内でイベント列から再計算する (ADR-0004 参照)
- W3C InputEvent: https://w3c.github.io/input-events/
