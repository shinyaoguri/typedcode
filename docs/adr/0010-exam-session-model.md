# ADR-0010: 試験モードのセッション構造 — 1問1タブ・固定・リロード復帰可能にする

- **Status**: Accepted (実装済み・develop マージ済み)。ただし**入場機構 (`?exam=1` + localStorage sticky + `?reset` 解除) は ADR-0011 で置換済み** — モードは URL パス (`/exam`) で確定し、storage はモード別名前空間化された。本 ADR のセッション構造 (1問1タブ・固定・リロード復帰) 自体は有効。
- **Date**: 2026-06-06 (Accepted: 2026-06-08)
- **Superseded-by**: [ADR-0011](0011-course-modes-and-path-routing.md) (sticky セッション部分のみ。`?exam=1` + localStorage → path 分岐 + storage 名前空間)
- **Deciders**: (PR 上の合意者 / レビュアー)
- **PR / Commit**: #78 (develop マージ済み)

> ADR-0006 (封印問題束縛) / ADR-0008 (fullscreen 記録) に続き、試験モードの **セッション構造**=タブとリロード復帰の振る舞いを確定する。最小骨組み (`?exam=1` + 問題パネルスタブ) は別 PR で実装済み。本 ADR は **問題ソースの実体 (封印パッケージ) を ADR-0006 に委ね**、その上に乗る「試験セッションとしての振る舞い」を決める。

## Context

試験会場の制約 (ADR-0006/0007/0008 と共通): **ネット不安定・100 人同時でも止めない / 受験者の答案はリロードで失われてはならない / "紙のように"**。これらを満たす試験モードの UX/構造を確定する。

既存実装の事実 (調査済み):

- **`TabManager` はリロード時にタブ (内容 + proof) を sessionStorage + IndexedDB から自動復元する** ([packages/editor/src/ui/tabs/TabManager.ts](../../packages/editor/src/ui/tabs/TabManager.ts))。→ **受験者の答案は既にリロードで残る**。
- 各タブは **独立した `TypingProof`** (multi-file proof モデル、`tabSwitches` をメタとして保持)。
- `createTab` は #0 で **Turnstile (humanAttestation)** を叩く (editor 不変条件 #1)。
- 現状の骨組みは試験モード判定を **`?exam=1` (URL 依存)** にしており、問題タブの生成・タブ操作制約は未実装。

→ 足りないのは **(a) 試験コンテキストの永続化** と **(b) タブ操作の制約**。

## Considered Options

### (1) リロード復帰モデル
- **Option A: URL パラメータ駆動** (`?exam` を維持し、タブ/問題は既存の自動復元任せ)
  - Pros: 実装が軽い。
  - Cons: **URL を編集/消去すると試験モードを抜けられる** (整合性が弱い)。問題パッケージの所在を URL が表現できない。
- **Option B: 試験セッションを永続化 (sticky)** ← 採用
  - 試験モード・問題セット・問題↔タブ対応を IndexedDB に保存。読み込み時に **URL 非依存で復元**し、**提出するまで sticky**。
  - Pros: リロード/クラッシュ/URL 編集に堅牢。整合性が高い ("抜けられない")。答案は既存自動復元に乗る。
  - Cons: 「終了」導線 (提出/エクスポートで clear) が必須。

### (2) 問題 ↔ タブ
- **Option A: アクティブタブに問題パネルが追従 (1:1)** ← 採用
  - タブ = 問題 = 答案。タブ切替で問題パネルの表示もそのタブの問題に切り替わる。
  - Pros: メンタルモデルが明快。multi-file proof に自然に乗る。
- **Option B: 問題一覧表示 + 答案ファイル別管理**
  - Cons: 問題とタブの紐付けが緩く、どの答案がどの問題かが曖昧。

### (3) タブ操作の制約
- **採用: 追加も削除も禁止 (1問1タブで固定)**。並べ替えは許可。
  - add-tab ボタンを無効化、close ボタンを非表示。問題の答案タブは消せない。
  - 「追加のみ禁止 (削除可)」も候補だったが、答案タブを誤って消せると試験として破綻するため削除も禁止。

## Decision

試験モードのセッション構造を以下に確定する。**問題ソースの実体 (復号・配布) は ADR-0006、本 ADR は構造のみ。**

1. **永続・sticky**: 試験セッション (試験モードである事・問題セット・問題↔タブ対応) を **IndexedDB に永続化**。読み込み時にそれがあれば **URL に関係なく試験モードを復元**。**提出 / エクスポートで試験セッションを終了 (clear)** する (誤って試験モードに固定されないため、終了導線を必ず設ける)。受験者の答案は既存のタブ自動復元に乗る。
2. **1問1タブ = 独立 proof**: 起動時に問題ぶんのタブを生成 (骨組みは 1 問 = 1 タブ)。各タブは独立 `TypingProof` (既存 multi-file proof)。
3. **タブ固定**: 試験モードでは **タブの追加・削除を禁止** (並べ替えは可)。`add-tab` 無効化 + close ボタン非表示。
4. **問題追従**: アクティブタブを切り替えると問題パネルの表示も **そのタブの問題に追従** (1:1)。

## Consequences

### Positive

- **リロード/クラッシュに堅牢で答案を失わない** (ネット不安定・100 人同時の制約に適合)。
- **URL 改竄で試験モードを抜けられない** (整合性)。
- 問題と答案が **1:1 で明快**。既存の自動復元・multi-file proof をそのまま活かせる (新規の永続機構は最小)。

### Negative / Trade-offs

- **Turnstile × 不安定ネット (要対処)**: 問題ぶんのタブを起動時に作ると #0 認証を **N 回**叩く → 100 人・不安定ネットで詰まり得る。**試験タブの #0 認証はネット非依存 / ベストエフォート**にすべき。最終形は **ADR-0006 の監督コード × 封印パッケージでチェーン根を作る** (Turnstile を試験タブの必須経路にしない)。本 ADR の前提として明記し、実装で対処する。
- **終了導線が必須**: sticky ゆえ、提出/エクスポートで試験セッションを確実に clear しないと試験モードに固定される。
- **問題ソースはスタブ**: 実体の問題配布は ADR-0006 (封印パッケージ) 待ち。本 ADR は構造のみ。

### Follow-ups / 残課題

- 実装: 試験セッションの IndexedDB スキーマ (examMode・問題セット・問題↔タブ)、読み込み時の URL 非依存復元、提出時 clear。
- 実装: `add-tab` 無効化 ([StaticEventListeners](../../packages/editor/src/app/) で `examMode` ガード)、close ボタン非表示 (`TabUIController`)、起動時の問題タブ生成、問題パネルのアクティブタブ追従。
- **試験タブの #0 認証のネット非依存化** (ADR-0006 と統合)。
- full ADR-0006 (封印パッケージ) と接続し、問題ソースを実体化。

## References

- [ADR-0006](0006-exam-mode-sealed-problem-binding.md) — 封印問題束縛 (問題ソースの実体・チェーン根)
- [ADR-0008](0008-exam-fullscreen-request-not-enforce.md) — fullscreen 記録 (exam 限定挙動の先例)
- [ADR-0007](0007-maximal-signal-capture.md) — 捕捉は両モード同一 (モード差は機能のみ)
- [packages/editor/src/ui/tabs/TabManager.ts](../../packages/editor/src/ui/tabs/TabManager.ts) — タブ自動復元・multi-file proof・`tabSwitches`
- [packages/editor/src/main.ts](../../packages/editor/src/main.ts) — `?exam` 判定・起動シーケンス
- [docs/system-spec.md](../system-spec.md) — proof / セッションの仕様
