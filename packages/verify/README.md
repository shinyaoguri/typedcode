# @typedcode/verify

TypedCode のエクスポートファイルを検証する Web アプリ。VSCode 風 UI で証明の妥当性を確認できます。

## 機能

- **ファイル投入**: ドラッグ＆ドロップ、ファイル選択、File System Access API によるフォルダ同期
- **ハッシュチェーン検証**: すべての SHA-256 ハッシュを再計算して検証
- **PoSW 検証**: Web Worker で Proof of Sequential Work を検証
- **検証モード**: full (PoSW 込み) / fast (PoSW 反復省略) の切替。未署名 cp の sampling は成功条件にしない (ADR-0004)
- **時刻アンカリングの検証**: 署名済みチェックポイントの ECDSA-P256 署名・連結ハッシュ・サーバ時刻整合性を検証 (詳細展開対応)
- **タイムライン可視化**: シークバー付きのインタラクティブなタイムライン
- **チャート**: マウス軌跡・イベント分布などを Chart.js で描画
- **スクリーンショット検証**: 撮影画像のハッシュ検証
- **試験束縛の検証**: `proof.exam` の root 束縛を検証し、`.tcexam` 問題パッケージを読み込めば署名・packageHash・問題内容まで完全検証 (ADR-0006)
- **三層保証バッジ**: 整合性 / 時刻アンカー / 著述性を分けて表示 (ADR-0020)
- **分析レポート (advisory)**: 打鍵動態などの手掛かりを検証結果とは独立に提示 (ADR-0009)
- **プロセス要約**: 作業時間・書き直し・停止などの中立な記述と「見どころ」へのジャンプ
- **マルチファイル**: ZIP 形式に含まれる複数ファイルの証明に対応
- **差分表示**: タブ切替や session 復旧をまたいだ差分の可視化
- **i18n**: 日本語と英語の UI

検証はすべてブラウザ内で完結します (ネットワークアクセスなし)。

## 開発

```bash
npm run dev      # http://localhost:5174
npm run build
npm run preview
```

## 主要な仕組み

### 検証の流れ

```
File Selection (ドラッグ＆ドロップ / File System Access API)
    ↓
FileProcessor (JSON パース or ZIP 展開)
    ↓
形式判定 (single-file / multi-file)
    ↓
VerificationEngine.verify()
    ↓
VerificationQueue (Web Worker)
    ├─ シーケンス番号チェック
    ├─ タイムスタンプ連続性チェック
    ├─ previousHash 検証
    ├─ ハッシュ再計算
    ├─ PoSW 検証 (POSW_ITERATIONS 反復)
    ├─ 署名済みチェックポイントの検証
    └─ runAnalysis (ADR-0009。advisory のみで valid に不反映)
    ↓
UI 表示 (三層保証バッジ, ResultPanel の各カード, charts)
```

### 検証モード (ADR-0004 のハードニング)

**未署名チェックポイントの sampling は成功条件にしない**。検証成功判定には常に**フルチェーン検証**を使う (PR #60)。モードは PoSW 再計算の有無だけを切り替える:

| モード | 内容 | 速度 |
|------|-----------|-------|
| **full** (既定) | チェーン整合 + content replay + metadata 再計算 + 全 PoSW 再計算 | O(n)、PoSW 込みで最も遅い |
| **fast** | full から PoSW の反復再計算のみ省略 (iterations の整合性は確認) | O(n)、PoSW 抜き |
| **audit** | 現状 full と同等 (将来: 決定的サンプリング余地) | O(n) |

署名済みチェックポイントは別レイヤの**時刻アンカリング**として連結検証する (チェーン検証の代替ではない)。詳細は [system-spec §6](../../docs/system-spec.md)。

### 三層保証バッジ (ADR-0020)

結果画面の最上部に、性質の異なる 3 つの保証を**分けて**表示します。導出は shared の `deriveAssurance` (verify-cli と同一実装)。

| チップ | 何を示すか |
|---|---|
| **整合性** | ハッシュチェーン・PoSW・スクリーンショットが改ざんされていないか |
| **時刻アンカー** | サーバ署名済みチェックポイントで時刻が裏付けられているか (root アンカー・アンカー密度を含む) |
| **著述性** | **常に advisory**。ピュアタイピングか否かと分析シグナル数の事実併記のみで、判定色は使わない |

入力は実証拠のみで、proof に記録された自己申告の `mode` は保証の導出に使いません (参考表示のみ)。

### 検証結果の判定 (`TrustCalculator`)

加減点スコアではなく **issue リスト**を組み立て、その最悪の severity から結果を決めます。

| severity | 例 |
|---|---|
| **error** → Failed | metadata 不正、ハッシュチェーン不正、スクリーンショットの改ざん、アンカー済み署名 cp が invalid、試験束縛の失敗 |
| **warning** → Partial | 未アンカー / アンカー密度が疎 (ADR-0016) / root 未サーバアンカー (ADR-0017)、非ピュアタイピング (ペースト・バルク挿入)、ソース不一致、画面共有のオプトアウト、スクリーンショット欠損 |
| (issue なし) → Verified | — |

### 分析レポート (ADR-0009)

検証 (valid) と**直交する advisory** として `AnalysisReportCard` に表示します。**判定ではありません** — 分析結果は `valid`・信頼バッジ・タブの状態に一切反映しません。

- 各シグナルは severity (`info` / `notice` / `review`) と要約に加え、**根拠となるイベント番号**を持ちます
- 根拠をクリックすると、そのイベント適用直後の状態へタイムラインがジャンプします (「シグナルを見る → 現場を検分」)
- 打鍵動態 (打鍵速度・キー押下間隔・ポーズなど) もここに advisory シグナルとして折り込まれます。**human / suspicious のような判定ゲージは持ちません** ([ADR-0023](../../docs/adr/0023-analysis-platform-not-judge.md) の非判定方針)
- 分析ロジックは `@typedcode/shared` に置きます (verify 側に分析器を書かない)

### プロセス要約カード

shared の `summarizeProcess` (純関数) の結果を、カード列の先頭に**中立な記述**として表示します (疑いの表示ではありません)。初回実行・最長停止・最大書き直し・復帰直後のバースト・外部入力といった「見どころ」から、当該イベントへジャンプできます。

### 試験束縛カード (ADR-0006)

`proof.exam` を持つ証明は、root 束縛を Web Worker が検証します。「問題パッケージを読み込む」から `.tcexam` を取り込むと、出題者署名・packageHash・復号した問題内容ハッシュ・提出期間まで検証して当該タブを再検証します。

### チャート可視化

| チャート | 用途 |
|-------|---------|
| **IntegratedChart** | 時間軸上のタイピング速度・フォーカス状態・キーストローク |
| **TimelineChart** | アノテーション付きイベント分布 |
| **MouseChart** | マウス位置ヒートマップ |

チャートは以下に対応:
- ズーム / パン (chartjs-plugin-zoom)
- 撮影時刻にスクリーンショットをオーバーレイ
- `ChartEventSelector` によるイベントフィルタ

## 対応形式

### 単一ファイル (JSON)

```json
{
  "version": "1.0.0",
  "typingProofHash": "sha256...",
  "typingProofData": {
    "finalContentHash": "...",
    "finalEventChainHash": "...",
    "metadata": { "isPureTyping": true }
  },
  "proof": {
    "events": [...],
    "finalHash": "..."
  },
  "fingerprint": { "deviceId": "...", "components": {...} },
  "checkpoints": [...]
}
```

### マルチファイル (JSON)

```json
{
  "version": "1.0.0",
  "type": "multi-file",
  "files": {
    "main.c": { /* MultiFileExportEntry */ },
    "utils.h": { /* MultiFileExportEntry */ }
  },
  "tabSwitches": [...],
  "fingerprint": {...},
  "metadata": { "totalFiles": 2, "overallPureTyping": true }
}
```

### ZIP 形式

- `proof.json` — 証明本体
- `screenshots/` — スクリーンショット (JPEG)
- `screenshots/manifest.json` — ハッシュとメタデータ
- `README.md`, `README.ja.md` — 検証手順

## 検証結果

| 結果 | 説明 |
|--------|-------------|
| Verified | issue なし |
| Partial | warning のみ (ペースト/ドロップ・未アンカーなど。上の severity 表を参照) |
| Failed | error あり (チェーン整合性の破綻・改ざん検出など) |

## 検証エラー

| エラー | 説明 |
|-------|-------------|
| Sequence mismatch | イベント順序が不整合 |
| Timestamp violation | タイムスタンプが逆行 |
| Previous hash mismatch | チェーンの連結が破綻 |
| PoSW verification failed | PoSW 値が不正 |
| Hash mismatch | 計算ハッシュと記録ハッシュが不一致 |
| Signed checkpoint mismatch | 署名済みチェックポイントの連結ハッシュが不一致 |

## File System Access API

verify アプリは File System Access API によるフォルダ同期に対応します。

```typescript
// フォルダを選択して自動同期
const handle = await showDirectoryPicker();
// 変更時に自動で再検証
```

開発中のリアルタイム検証に便利です。

## 依存関係

| パッケージ | バージョン | 用途 |
|---------|---------|---------|
| @typedcode/shared | * | コア型と検証ロジック |
| chart.js | ^4.4 | チャート描画 |
| chartjs-plugin-annotation | ^3.0 | チャートのアノテーション |
| chartjs-plugin-zoom | ^2.0 | チャートのズーム/パン |
| diff | ^9.0 | 差分計算 |
| highlight.js | ^11.11 | シンタックスハイライト |
| jszip | ^3.10 | ZIP の解凍 |
| vite | ^8.0 | ビルドツール |

## 環境変数

なし。verify アプリは Workers API を含む外部サービスを一切呼びません (証明の検証はすべてクライアント側で完結します)。
