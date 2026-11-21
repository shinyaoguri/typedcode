# packages/verify — 結果画面 (分析カード・三層保証バッジ・プロセス要約・レイアウト)

結果パネルのカード・バッジ・シークバー・チャートの配置を触るときに読む。[AGENTS.md](../AGENTS.md) から移した節。

## 分析カード (ADR-0009)

- worker が検証後に shared の `runAnalysis` を実行し `VerificationResultData.analysis` で返す。**advisory であって判定ではない** — `valid` / TrustCalculator / タブ status には一切反映しない (ここを破ると ADR-0009 の直交性が壊れる)
- 表示は `AnalysisReportCard` (`#card-analysis`)。severity (`info`/`notice`/`review`)・score/confidence・summary に加え **evidence (event index) をボタンで出す**
- evidence クリックは `document` に `verify:seek-to-event` CustomEvent を dispatch し、`ChartController` が `SeekbarController.seekTo(eventIndex + 1)` で当該イベント適用後の状態へジャンプする (「シグナルを見る → 現場を検分」の 1 クリック化)
- 分析ロジックは shared に置く。verify 側に分析器を書かない (テストの厚みが shared 側にあるため。verify のユニットテストは #135 で導入済みだが純関数中心)
- **分析できなかった分析器を「シグナルなし」と見せない** (#301): `runAnalysis` は分析器ごとに期限 (shared の `ANALYZER_TIMEOUT_MS` = 10 秒) を付け、throw・期限切れ・不正な出力を `AnalysisReport.analyzerStatus` に残して resolve する。解決しない分析器があっても検証結果は期限後に返る。カードは `analysisAvailability` で `complete` / `partial` / `unavailable` を決め、カードの `data-analysis-availability` (状態契約) に出す。`unavailable` (ok の分析器が 0) はバッジを「分析不能」(warning)、`partial` は注記を出し、分析器の一覧に status (`data-analyzer-status`) と message を出す。「分析シグナルなし」は `complete` のときだけ。message と id は外部分析器が決められる未信頼の文字列なので `escapeHtml` を通す。`runProofVerification` の `analyzers` / `analysisTimeoutMs` はテストの継ぎ目 (本番は渡さない)。全滅のとき `summarizeAnalysisForAssurance` が undefined を返し、著述性の signal 数も null になる

## 三層保証バッジ (ADR-0020)

- 結果画面最上部の `#assurance-strip` に **整合性 / 時刻アンカー / 著述性** の 3 チップ (+ 自己申告 mode の参考チップ) を出す。導出は shared の `deriveAssurance` (**verify 側で再実装しない** — CLI と食い違うため)
- 導出は `TabController.renderResult` で行う (スクショ改竄数を持つのがこの層だけのため)。入力は実証拠のみで **自己申告 `proof.mode` は使わない**。`AssuranceInput` への写像は `proofVerification.buildAssuranceInput` に切り出してあり、verify-cli の同じ写像との一致をパリティテストが固定する (#216)
- **著述性チップは常に advisory**: 判定色 (緑/赤) を使わず破線・中立色。pureTyping + シグナル数の事実併記のみ。ここを判定に見せる変更は ADR-0009/0020 違反
- 既存の TrustCalculator (issue リスト) とタブ status は詳細表示として併存。三層バッジは語彙、issue は根拠の列挙という役割分担

## プロセス要約カード (Phase 8 W3)

- shared の `summarizeProcess` (純関数) を `buildResultData` で実行し、カード列の先頭 `#card-process-summary` に表示。**中立な記述であって疑い表示ではない** (疑いは AnalysisReportCard)
- 見どころ (初回実行 / 最長停止 / 最大書き直し / 復帰直後バースト / 外部入力) は `verify:seek-to-event` で当該イベントへジャンプ (分析カードと同じ経路)
- 抽出ロジックは shared に置く (テストは shared 側)。閾値も shared の `PROCESS_*` 定数が単一ソース
- **再生 (W3-C)**: `SeekbarController` は再生モード `steps` (50ms/イベント・従来) と `x1/x10/x60` (イベント timestamp に比例 — 停止やバーストの緩急が見える) を持つ。`#seekbar-speed` で巡回。**見どころマーカー** は `setKeyMoments(moments)` で `#seekbar-markers` に描画 (kind 別の色・クリックでシーク)。moments は TabController が `summarizeProcess(events)` から渡す

## UI レイアウトの不変条件 (UI レビュー 2026-06-12)

- **チャート/シークバーはステータスカード直後 (result-cards の前)** に置く。採点の主要ツールなので 9 枚のカードの下に埋めない (index.html の `#chart-section` 位置)。戻さないこと
- **シークバー初期化は content をガードにしない**: `TabController.renderCharts` は `proofData.content` の有無に関わらず `seekbarController.initialize` を呼ぶ。proof.json 単体 (ソースファイルなし) では content が無く、`SeekbarController` が events から最終状態を再構成する。content ガードを戻すと JSON 単体で再生/マーカーが死ぬ
- **読込直後の自動オープン**: `VerificationController.handleComplete` が「アクティブタブが null なら最初に完了した proof を `openTabForFile`」する。ウェルカム画面のまま放置しない
- **ステータスカードは縦 2 段**: 上段 `.result-status-row` (アイコン+タイトル+ミニゲージ)、下段 `#assurance-strip` (三層バッジ全幅)。横 1 列に詰めると三層チップとタイトルが重なって縦書き崩れする
- **分析シグナルの文言は `summaryKey` 優先**: `AnalysisSignal.summaryKey` があれば verify 側で `t()` ローカライズ (shared は i18n を持たないため)。`summary` は英語フォールバック。analyzer に生英語を直書きしない
- **打鍵動態は AnalysisReportCard に統合済み (ADR-0009)**: 旧 `TypingPatternCard` (human/uncertain/suspicious の判定スコアゲージ) は ADR-0023 の非判定方針と緊張するため廃止し、shared の `typingPatternAnalyzer` が `TypingPatternAnalyzer` の所見を `keystroke-content-consistency` 次元の **advisory signal** として `runAnalysis` に折り込む。判定ゲージは持ち込まず issue ベースの手掛かりのみ。**W5 ゲートで `review` には上げない** (critical も notice 止まり)。打鍵動態サンプルが乏しい proof では黙る (★6b 配慮)。verify 側に分析器を書かない原則どおりロジックは shared。
