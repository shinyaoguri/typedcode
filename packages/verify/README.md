# @typedcode/verify

TypedCode のエクスポートファイルを検証する Web アプリ。VSCode 風 UI で証明の妥当性を確認できます。

## 機能

- **ファイル投入**: ドラッグ＆ドロップ、ファイル選択、File System Access API によるフォルダ同期
- **ハッシュチェーン検証**: すべての SHA-256 ハッシュを再計算して検証
- **PoSW 検証**: Web Worker で Proof of Sequential Work を検証
- **サンプリング検証**: チェックポイントを利用した高速検証
- **時刻アンカリングの検証**: 署名済みチェックポイントの ECDSA-P256 署名・連結ハッシュ・サーバ時刻整合性を検証 (詳細展開対応)
- **タイムライン可視化**: シークバー付きのインタラクティブなタイムライン
- **チャート**: マウス軌跡・イベント分布などを Chart.js で描画
- **スクリーンショット検証**: 撮影画像のハッシュ検証
- **人間認証の検証**: Turnstile アテステーション署名を検証
- **マルチファイル**: ZIP 形式に含まれる複数ファイルの証明に対応
- **差分表示**: タブ切替や session 復旧をまたいだ差分の可視化
- **i18n**: 日本語と英語の UI

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
    └─ 署名済みチェックポイントの検証
    ↓
AttestationService.verify() (Workers API)
    ↓
UI 表示 (ResultPanel, charts)
```

### サンプリング検証 vs フル検証

| モード | 適用条件 | 速度 | 精度 |
|------|-----------|-------|----------|
| **サンプリング** | チェックポイントあり | 高速 (O(samples)) | 統計的保証 |
| **フル** | チェックポイントなし | 低速 (O(n)) | 100% 検証 |

サンプリング検証では、以下のセグメントを必須に含めつつランダムに選択して検証します。

1. 先頭セグメント (初期ハッシュ → 最初のチェックポイント)
2. 末尾セグメント (最後のチェックポイント → 最終ハッシュ)
3. 中間セグメントをランダムに選択

これにより大規模な証明ファイルでも高速かつ統計的に保証された検証ができます。

### 信頼スコアの計算

`TrustCalculator` は以下の要素から信頼スコアを算出します。

| 要素 | 影響 |
|--------|--------|
| ピュアタイピング | 信頼度+ |
| 人間認証あり | 信頼度+ |
| タイムスタンプ整合 | 必須 |
| ハッシュチェーン有効 | 必須 |
| ペースト/ドロップ存在 | 信頼度- |
| テンプレート注入 | 注記対象、許可 |
| 画面共有のオプトアウト | 注記対象 |

### タイピングパターン分析

`TypingPatternCard` で以下を分析します。

- 時間あたりのタイピング速度 (WPM)
- キー押下間隔 (dwell / flight time)
- ポーズパターン
- フォーカス/ブラー頻度

自動入力の疑いがある不自然なパターンを検出する助けになります。

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
| Verified | すべての検査を通過、ピュアタイピング |
| Partial | チェーン有効だがペースト/ドロップを含む |
| Failed | チェーン整合性が破綻 |

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

| 変数 | 説明 | 必須 |
|----------|-------------|----------|
| `VITE_API_URL` | Workers API のエンドポイント (アテステーション検証用) | 任意 |
