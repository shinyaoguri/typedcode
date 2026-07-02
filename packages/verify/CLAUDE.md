# packages/verify — CLAUDE.md

`@typedcode/verify` は **エクスポート ZIP を独立に検証する Web アプリ**。エディタとは別ドメインでも動くべきで、検証はクライアント側で完結する。

## 責務と境界

- **持つ**: ファイル投入 (drag&drop / FSA API)、Worker 経由のチェーン検証、PoSW 検証、署名済み cp の検証、UI 表示 (タイムライン、チャート、信頼スコア)、差分表示
- **持たない**: イベント生成、proof の改変。**読み取り専用**

## 重要な不変条件

1. **検証は cp の間隔を仮定しない** ([docs/adr/0004-verifier-checkpoint-stance.md](../../docs/adr/0004-verifier-checkpoint-stance.md)): 33 イベントごとでも 100 イベントごとでも 1 cp しかなくても動かなくてはいけない。`shared` 側の `CHECKPOINT_INTERVAL` の値を hard-code しない
2. **未署名 cp の sampling を信頼しない**: 検証成功条件として「サンプリングで OK だった」だけでは不可。フルチェーン検証または署名済み cp の連結検証が前提 (PR #60 のハードニング)
3. **検証 (Web Worker) は決定的**: `workers/verificationWorker.ts` は同じ proof に対して常に同じ結果を返す。乱数 / 時刻 / ネットワーク状態に依存しない (Workers の attestation 検証のみネットワーク依存だが、結果は cache 可)
4. **マルチタブ proof はタブ毎に独立した `<name>_proof.json` を N 個**として扱い、各タブを個別に検証する (verify-cli は全件検証、verify(web) はタブごと)。`MultiFileExportedProof` / `isMultiFileProof()` 型は存在するが現状のエクスポート経路では未使用 (dead)
5. **i18n キーは型と同期**: `src/i18n/types.ts` の `VerifyTranslationKeys` に新規キーを追加しないと TS2353 が出る

## ディレクトリ一覧

| ディレクトリ | 役割 |
|---|---|
| `ui/` | `AppController`, `TabBar`, `ActivityBar`, `StatusBarUI`, `ResultPanel`, `Sidebar`, `AnalysisReportCard` (ADR-0009 の advisory 表示。打鍵動態の旧 `TypingPatternCard` はここに統合済み), `ProcessSummaryCard` (W3 プロセス要約), `ChartEventSelector` |
| `ui/controllers/` | `VerificationController`, `TabController`, `FileController`, `FolderController`, `ChartController` |
| `state/` | `VerificationQueue`, `UIStateManager`, `VerifyTabManager`, `ChartState` |
| `charts/` | `TimelineChart`, `MouseChart`, `IntegratedChart`, `SeekbarController` (Chart.js) |
| `services/` | `FileSystemAccessService`, `FolderSyncManager`, `SyntaxHighlighter`, `TrustCalculator`, `DiffService`, `ChartPreferencesService` |
| `workers/` | `verificationWorker.ts` (Web Worker ベースの検証) |

## データフロー

```
File Selection (drag&drop / FSA API)
  → FileProcessor (JSON / ZIP)
  → 形式判定 (single / multi: タブ毎に独立 proof)
  → VerificationController → VerificationQueue
  → workers/verificationWorker.ts (Web Worker)
     ├─ sequence 連続性
     ├─ timestamp 単調性
     ├─ previousHash 検証
     ├─ ハッシュ再計算
     ├─ PoSW (POSW_ITERATIONS 反復)
     ├─ 署名済み cp の連結検証 (任意)
     └─ runAnalysis (ADR-0009。advisory のみ・valid に不反映・失敗しても検証結果を落とさない)
  → AttestationService.verify() (Workers API)
  → ResultPanel + charts
```

## 信頼スコア (`TrustCalculator`)

`TrustCalculator.calculate` は加減点スコアではなく **issue リスト** を組み立て、`determineLevel` で `failed`(error あり) / `partial`(warning あり) / `verified`(issue なし) に落とす。issue を上げる要素:

- **error**: metadata 不正、ハッシュチェーン不正、スクショ改竄、署名 cp が anchored だが invalid、exam 束縛失敗 (package 提供時)
- **warning**: 未アンカー (署名 cp なし)、post-hoc 一括署名疑い、**アンカー密度が疎 (ADR-0016, `signedCheckpointDensity.sparse`)**、**root 未サーバアンカー (ADR-0017, `!rootAnchored` かつ非 exam)**、非ピュアタイピング (ペースト/バルク挿入)、ソース不一致、attestation 検証失敗、`screenShareOptOut`、exam だが問題パッケージ未読込、スクショ欠損

`VerificationController.handleComplete` のタブ status 判定と **同じ軸** を見るので、両者を揃えて変更すること (タブが緑なのに信頼バッジが警告、のような不整合を避ける)。`component` を増やしたら `ResultPanel.getComponentLabel` にラベルも追加する。#146 で handleComplete にスクショ改竄 (error)・スクショ欠損・`screenShareOptOut` (warning) を合流済み。attestation 失敗は `humanAttestationResult` の書き込み元が現状無い (dead) ため status 軸に入れていない。

スクショの per-image 判定 (ハッシュ突合 + チェーン裏付け) の実体は **shared の `checkScreenshotImage`** (#147)。verify 側で再実装しない — verify-cli と結論が食い違うため。

## よくある罠

- **`finalChainHash` の検証は 2 段**: `proof.finalHash` が記録値、`verifyFinalChainHash` が再計算値。両者一致を確認する
- **File System Access API はブラウザ依存**: Chrome/Edge のみ。フォールバック (`<input type="file">`) を維持
- **チャートのズーム / パン状態は `ChartPreferencesService` で永続化**: 検証結果のリセット時にクリアするか、ユーザー設定として残すかの線引きに注意
- **マルチファイル proof の `tabSwitches`**: タブごとの最終ハッシュとつながっている。タブの順序を変えるとチェーンが切れる
- **試験束縛カード (ADR-0006)**: `proof.exam` がある proof は root 束縛を worker が runtime で検証済み (`verifyInitialHashRoot` の exam 分岐。worker は proofData 全体を受け取る)。完全束縛 (署名/復号/内容) は **`.tcexam` を「問題パッケージを読み込む」で取り込んだとき** `verifyExamBinding` で検証 → `VerificationQueue.reverifyWithManifest` で当該タブのみ再検証。result-card は**折りたたみ式** (`.result-card-content` は既定 `display:none`、ヘッダクリックで展開) なので、ボタンは展開後に現れる

## 分析カード (ADR-0009)

- worker が検証後に shared の `runAnalysis` を実行し `VerificationResultData.analysis` で返す。**advisory であって判定ではない** — `valid` / TrustCalculator / タブ status には一切反映しない (ここを破ると ADR-0009 の直交性が壊れる)
- 表示は `AnalysisReportCard` (`#card-analysis`)。severity (`info`/`notice`/`review`)・score/confidence・summary に加え **evidence (event index) をボタンで出す**
- evidence クリックは `document` に `verify:seek-to-event` CustomEvent を dispatch し、`ChartController` が `SeekbarController.seekTo(eventIndex + 1)` で当該イベント適用後の状態へジャンプする (「シグナルを見る → 現場を検分」の 1 クリック化)
- 分析ロジックは shared に置く。verify 側に分析器を書かない (verify はテスト未整備のため)

## 三層保証バッジ (ADR-0020)

- 結果画面最上部の `#assurance-strip` に **整合性 / 時刻アンカー / 著述性** の 3 チップ (+ 自己申告 mode の参考チップ) を出す。導出は shared の `deriveAssurance` (**verify 側で再実装しない** — CLI と食い違うため)
- 導出は `TabController.renderResult` で行う (スクショ改竄数を持つのがこの層だけのため)。入力は実証拠のみで **自己申告 `proof.mode` は使わない**
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
