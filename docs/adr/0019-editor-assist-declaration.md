# ADR-0019: エディタ支援機能の実効状態を proof に宣言する (editor-assist 宣言)

- **Status**: Accepted
- **Date**: 2026-06-12
- **Deciders**: (PR 上の合意者 / レビュアー)
- **PR / Commit**: (本 ADR と同一 PR)

## Context

TypedCode の主張は「このコードは打鍵で書かれた」だが、**「打鍵」の境界はエディタ支援機能の有効状態に依存する**。現状の editor は `monaco.editor.create` で suggest 系オプションを指定しておらず、**Monaco 既定の補完 (quickSuggestions・トリガ文字での候補・単語ベース補完・スニペット・括弧自動閉じ) が有効なまま**動いている。さらに TS/JSON 等の language worker による IntelliSense も生きている。

問題は支援機能の有無そのものではなく、**proof からそれが分からない**こと:

- 検証者・採点者は「補完ありの環境で書かれた proof」と「補完なしの proof」を区別できず、セッション間の前提が比較不能
- 将来、補完ポリシーを変更 (例: exam で suggest off) したとき、変更前後の proof を同じ土俵で読めない
- ゴーストテキスト型のインライン補完 (`inlineSuggest`) は AI 補完系が乗る経路であり、有効/無効の事実が残らないのはコンセプト上の穴
- ADR-0007 の判定テスト「実行時にしか存在しない事実か?」に YES — 実効オプションは記録時にしか取れない (**捕捉は不可逆**)

なお IME (`isComposing`/composition イベント) は既に捕捉済みで本 ADR の対象外。本 ADR は「何が有効だったか」の**事実の宣言**であり、「何を有効にすべきか」の**ポリシー決定はしない** (後者は別 ADR)。

## Considered Options

### Option A: 支援機能を全モードで無効化する (記録不要にする)
- Pros: 「純粋な打鍵」の定義が単純になる。
- Cons: ポリシー決定を事実記録に先行させてしまう。括弧自動閉じ・インデントまで切ると通常の編集体験を大きく損ない、casual/class の現実的な利用と衝突する。**支援込みで書くのが現代の通常のプログラミング**であり、一律禁止はコンセプト (過程の忠実な記録) に反する。→ 却下
- 補完を切る/残すの判断はモード別ポリシーとして将来別 ADR で行えばよく、その時も「宣言」は必要。

### Option B: 実効状態を proof に宣言する (記録のみ、ポリシー判断はしない) ★採用
- Monaco の**解決済みオプション** (`editor.getOptions()`) から支援機能関連の値を正規化し、起動時ワンショットの `environmentProbe` イベントに加算的フィールドとして焼く。
- Pros: 事実が改ざん耐性つきで残る。比較可能性が生まれる。将来のポリシー gating (「exam では inlineSuggest=false を要求」等) の機械検証可能な土台になる。proof フォーマット非破壊。
- Cons: 宣言対象オプションの選定メンテが要る (Monaco バージョン追従)。

### Option C: 何もしない (現状維持)
- Cons: 上記の穴が放置され、補完ポリシーを将来変えた時点で過去 proof との比較可能性が永久に失われる。→ 却下

## Decision

Option B を採用。

1. **宣言の格納先**: `EnvironmentProbeData.editorAssist` (optional、加算的)。`environmentProbe` は起動時ワンショットで全タブに記録される既存イベントであり、新イベント型は増やさない。旧 proof には存在しない (検証互換、`PROOF_FORMAT_VERSION` 据え置き)。
2. **宣言スキーマ**: `EditorAssistDeclaration` (`schema: 'editor-assist/1'`)。対象は**バッファ内容を生成・変形しうる支援機能 + 候補表示**: `quickSuggestions` / `suggestOnTriggerCharacters` / `wordBasedSuggestions` / `snippetSuggestions` / `inlineSuggest` / `tabCompletion` / `acceptSuggestionOnEnter` / `parameterHints` / `autoClosingBrackets` / `autoClosingQuotes` / `autoSurround` / `formatOnType` / `formatOnPaste`。フィールド追加時は schema 版を上げる (versioned スキーマ、ADR-0007 規約)。
3. **値は解決済みオプションから取る**: `editor.getOptions().get(EditorOption.X)`。raw 指定値ではなく実効値 (既定値含む) を記録する。例外: `wordBasedSuggestions` は `IGlobalEditorOptions` 所属で実行時に実効値を読む API が Monaco に無いため、現状は null (graceful absence)。エディタが明示設定するようになったらその値を宣言に渡す。
4. **graceful absence**: 取得不可・未知の型は捏造せず `null` (ADR-0007 規約 ①)。正規化は Monaco 非依存の純関数 `buildEditorAssistDeclaration` (`packages/editor/src/tracking/editorAssist.ts`) が担い、node 環境でテストする。
5. **ポリシーはまだ決めない**: 本 ADR は宣言のみ。「exam で suggest を切るか」「宣言値を検証 gate に使うか」は将来の別 ADR (その時、本宣言が機械検証の入力になる)。

## Consequences

### Positive

- 「どの支援機能が有効な環境での記録か」が proof に焼かれ、セッション間・ポリシー変更前後の比較可能性が恒久化する。
- AI 補完の主経路 (`inlineSuggest`) の有効状態が事実として残る。
- 将来のモード別補完ポリシー (別 ADR) を非破壊で導入できる (宣言は既に回収済みのため過去分も読める)。
- 新イベント型・proof フォーマット変更なしの加算的変更。

### Negative / Trade-offs

- Monaco のオプション体系変更への追従メンテ (正規化が boolean/enum/object の版差を吸収して緩和)。
- 宣言は自己申告と同水準 (クライアント半信頼)。フル recorder 再実装には偽造可能 — 既存の全捕捉と同じ限界で、本宣言だけ特に弱いわけではない。
- カスタム補完プロバイダの登録状況までは宣言しない (現状 editor は登録していない。登録する時はフィールド追加 + schema 版上げ)。

### Follow-ups / 残課題

- verify UI / CLI での宣言表示 (Phase 8 W2/W3 の保証語彙・要約カードに合流)。
- モード別補完ポリシーの決定 (例: exam で quickSuggestions/inlineSuggest を off にするか) — 別 ADR。
- 宣言を分析層 (ADR-0009) の入力に使う analyzer (例: 補完無効宣言なのに補完様の挿入パターン) — 将来。

## References

- [ADR-0007](0007-maximal-signal-capture.md) — 捕捉最大化と堅牢性規約 (graceful absence / 加算的 versioned スキーマ)。本宣言はその追補
- [ADR-0005](0005-input-type-policy.md) — InputType の許可/禁止 (入力出自の既存方針。本 ADR は「出自」でなく「環境の支援状態」を扱う)
- [ADR-0009](0009-pluggable-analysis-layer.md) — 分析層 (本宣言の将来の消費者)
- `packages/editor/src/tracking/editorAssist.ts` — 正規化の実装
- `packages/editor/src/tracking/EnvironmentTracker.ts` — 格納先イベントの記録元
- `packages/shared/src/types/events.ts` — `EditorAssistDeclaration` / `EnvironmentProbeData`
