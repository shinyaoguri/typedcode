# ADR-0021: コード実行の結果 (成功/失敗) を加算的に捕捉する

- **Status**: Accepted
- **Date**: 2026-06-12
- **Deciders**: (PR 上の合意者 / レビュアー)
- **PR / Commit**: (本 ADR と同一 PR)

## Context

`codeExecution` イベントは**実行開始のみ**を data 無しで記録しており、結果 (成功/失敗/exit code) が
proof に残らない。このため教育的に最も価値の高い「**失敗 → 修正 → 成功**」のデバッグサイクルが
プロセス要約 (Phase 8 W3) からも将来の分析器 (ADR-0009) からも導出できない。

ADR-0007 の判定テスト「将来の分析器が記録済みストリームからこれを計算できるか?」に対し、
実行結果は **NO (実行時にしか存在しない事実)** — つまり捕捉は不可逆で、録り損ねた試験・課題の
セッションは二度と再現できない。Phase 8 W3 の実装中にこのギャップが顕在化したため、
後続作業 (W4 セルフビュー・W5 実証) より先に塞ぐ。

## Considered Options

### Option A: 開始イベントの data を完了時に書き換える
- Cons: イベントは追記専用 (ハッシュチェーン)。書き換えは構造的に不可能。→ 却下

### Option B: 新イベント型 `codeExecutionResult` を追加する
- Pros: 型で開始/結果が分かれる。
- Cons: EventType が増え、旧 verifier の未知イベント型耐性・proof フォーマット版数の議論を
  引き起こす。情報は既存型の data で表現できる。→ 却下

### Option C: `codeExecution` を start / result の 2 イベントにする (data で区別) ★採用
- start: `data: { phase:'start', filename, language }` (従来は data: null)
- result: `data: { phase:'result', filename, language, outcome, exitCode, elapsedMs }`
- `outcome`: `success` (exit 0) / `failure` (非 0 exit) / `error` (実行基盤の例外) /
  `aborted` (ユーザ中断)
- Pros: **新イベント型なし・加算的** (旧 proof の data:null は start 相当として解釈)。
  data はハッシュ対象なので結果も改ざん耐性を持つ。
- Cons: 1 実行 = 2 イベントになる (消費側は phase で区別する)。

## Decision

Option C を採用。

1. **記録**: `CodeExecutionController.run()` が start を記録し、全終端経路 (正常終了 /
   実行基盤例外 / 中断) から **1 回だけ** result を記録する (`recordResult` ガード)。
   出力テキストは記録しない (容量とプライバシー。exit code と outcome で十分)。
2. **消費**: `summarizeProcess` (W3) が `executionCount` (start)・`runSuccessCount` /
   `runFailureCount` (result。aborted は数えない)・`hasRunResults` (結果が記録された
   ビルドか) を集計し、見どころ **`first-failed-run`** / **`first-success-after-failure`**
   (デバッグサイクルの結実) を抽出する。
3. **互換**: 旧 proof (data:null) は「開始のみ・結果不明」として扱う (`hasRunResults=false`
   で UI は成功/失敗を表示しない)。proof フォーマット版数は据え置き (加算的)。

## Consequences

### Positive

- デバッグサイクル (失敗 → 修正 → 成功) が proof から決定的に導出可能になる。
  process-first 路線 (過程を評価する) の中核データ。
- 将来の分析器の材料が増える (例: 失敗直後の編集パターン)。
- 改ざん耐性: 結果は event data としてハッシュチェーンに焼かれる。

### Negative / Trade-offs

- 実行ごとにイベントが 1 → 2 件になる (イベント総数への影響は軽微)。
- 「成功した」のは**そのコードがそのスタブ入力で exit 0 だった**ことに過ぎず、
  正しさの証明ではない (採点者向けの注意書きが要る — 表示は中立)。
- 既存の消費側 (LogViewer 等) は data 無し前提の表示があり得る — 追従は表示のみで安全。

### Follow-ups / 残課題

- editor の LogViewer / LogViewerExporter の codeExecution 表示を phase 対応にする (表示のみ)。
- 分析器での活用 (失敗 → 編集 → 再実行の系列分析) — ADR-0009 の枠で将来。

## References

- [ADR-0007](0007-maximal-signal-capture.md) — 捕捉は不可逆・分析は後回し可 (本 ADR の根拠原則)
- [ADR-0009](0009-pluggable-analysis-layer.md) — 将来の消費者
- `packages/shared/src/types/events.ts` — `CodeExecutionEventData`
- `packages/shared/src/processSummary.ts` — 消費側 (W3)
- `packages/editor/src/execution/CodeExecutionController.ts` — 記録側
