# @typedcode/verify-cli

TypedCode のタイピング証明ファイルを検証するコマンドラインツールです。

## インストール

### グローバルインストール

```bash
npm install -g @typedcode/verify-cli
```

### npx (インストールなし)

```bash
npx typedcode-verify <proof-file>
```

## 使い方

```bash
# 単一の JSON ファイルを検証
typedcode-verify proof.json

# スクリーンショット付き ZIP を検証
typedcode-verify proof.zip

# 複数ファイルを指定
typedcode-verify file1.json file2.zip
```

## 出力例

```
Verifying: proof.json

Result: VERIFIED

Summary:
  Total Events: 1,234
  Pure Typing: Yes
  Duration: 45m 30s
  Typing Speed: 45.2 WPM (avg)

Chain Verification:
  Sequence: OK
  Timestamps: OK
  Hash Chain: OK
  PoSW: OK (1,234/1,234)

Attestation:
  Human Verified: Yes
  Timestamp: 2026-01-05T10:30:00Z
```

## 終了コード

| Code | 説明 |
|------|-------------|
| 0 | 検証成功 |
| 1 | 検証失敗 / エラー |

## 対応形式

| 形式 | 拡張子 | 説明 |
|--------|-----------|-------------|
| 単一ファイル | `.json` | 1 ファイルの証明 |
| マルチファイル | `.json` | 複数ファイルを 1 つにまとめた証明 |
| ZIP | `.zip` | スクリーンショット付きの証明 |

## 検証ステップ

1. **ファイル解析**: JSON / ZIP を読み込み
2. **形式判定**: single-file か multi-file かを判定
3. **チェーン検証**:
   - シーケンス番号の連続性
   - タイムスタンプの単調性
   - previousHash の整合
   - ハッシュの再計算
4. **PoSW 検証**: シーケンシャル証明を `POSW_ITERATIONS` 反復で検証
5. **アテステーション検証**: 人間認証がある場合は署名検証
6. **署名済みチェックポイント検証**: 任意。サーバ署名と連結ハッシュを検証

## ビルド

```bash
npm run build      # ビルド
npm run dev        # watch モード
```

## アーキテクチャ

```
src/
├── cli.ts         # CLI エントリポイント
├── verify.ts      # 検証ロジック
├── output.ts      # 結果の整形
├── progress.ts    # 進捗表示
└── zip.ts         # ZIP ファイル処理
```

## 動作要件

- Node.js >= 24.0.0

## 依存関係

| パッケージ | 用途 |
|---------|---------|
| @typedcode/shared | コア型と検証ロジック (ZIP 処理を含む) |
