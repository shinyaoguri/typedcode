# @typedcode/verify-cli

TypedCode のタイピング証明ファイルを検証するコマンドラインツールです。

## インストール

現状 npm には**未公開**です。モノレポ内でビルドして使います:

```bash
npm run build:verify-cli
node packages/verify-cli/dist/cli.js <proof-file>
```

> 以降の例では `typedcode-verify` をコマンド名として表記しますが、公開前は `node packages/verify-cli/dist/cli.js` に読み替えてください。公開後は `npm install -g @typedcode/verify-cli` / `npx typedcode-verify` を予定 (バンドルが必要・将来課題)。

## 使い方

```bash
# 単一の JSON ファイルを検証
typedcode-verify proof.json

# スクリーンショット付き ZIP を検証
typedcode-verify proof.zip

# 複数ファイルを指定
typedcode-verify file1.json file2.zip

# 検証モード (既定 full。fast は PoSW 反復をスキップ)
typedcode-verify proof.zip --mode fast

# 試験モード (ADR-0006): 問題パッケージ (.tcexam) を渡して束縛を完全検証
typedcode-verify ALL_TC.zip --exam-package p1.tcexam
# 提出時刻を渡すと time-box (提出期間内か) も判定
typedcode-verify ALL_TC.zip --exam-package p1.tcexam --submitted-at 2026-06-06T01:00:00Z
```

### 試験モード (ADR-0006)

`proof.exam` を持つ答案は、`--exam-package` を**指定しなくても** root 束縛 (答案が「その問題・試験開始以降」に紐づくこと) を検証します。`--exam-package <file.tcexam>` を渡すと、問題の真正性 (出題者署名)・packageHash・復号した問題内容ハッシュ・提出期間まで完全に検証します (`--submitted-at` で提出時刻を指定)。

## 出力例

```
=== TypedCode Proof Verification ===

✓ Verification PASSED

--- Details ---
Language:        javascript
Total Events:    1,234
Verify Duration: 1.8s

--- Checks ---
Metadata:    PASS
Hash Chain:  PASS
Pure Typing: YES (no paste/drop detected)
PoSW:        10,000 iterations/event — VERIFIED
Mode:        casual
Anchoring:   VERIFIED (12 signed checkpoints, 100.0% coverage)
```

複数 proof を含む ZIP では各 `*_proof.json` を順に検証し、末尾に `=== Summary: N/M proofs passed ===` を出します (1 件でも失敗すれば exit 1)。`--mode fast` のときは PoSW 行が `SKIPPED (fast mode)`、署名 cp が無いときは `Anchoring: unavailable` になります。

## 終了コード

| Code | 説明 |
|------|-------------|
| 0 | 検証成功 |
| 1 | 検証失敗 / エラー |

## 対応形式

| 形式 | 拡張子 | 説明 |
|--------|-----------|-------------|
| 単一ファイル | `.json` | 1 タブの証明 |
| ZIP | `.zip` | スクリーンショット付き。exam/class はタブ毎に独立した `*_proof.json` を N 個含み、**全件**検証する (1 件でも fail なら exit 1) |

## 検証ステップ

1. **ファイル解析**: JSON / ZIP を読み込み (ZIP は構造判定 `isProofFile` で全 proof を抽出)
2. **チェーン検証**: シーケンス連続性 / タイムスタンプ単調性 / previousHash 整合 / ハッシュ再計算
3. **PoSW 検証**: `POSW_ITERATIONS` 反復で検証 (`--mode fast` ではスキップ。iterations の整合性は確認)
4. **メタデータ再計算**: paste/drop/bulk insert を再カウントし `isPureTyping` を再判定
5. **content replay**: `contentChange` 等を再生して最終コードと照合
6. **署名済みチェックポイント検証**: 任意。サーバ署名・連結ハッシュ・時刻整合を検証
7. **試験束縛検証** (ADR-0006、`proof.exam` がある場合): root 束縛 (自己完結) +、`--exam-package` 指定時は署名・packageHash・問題内容ハッシュ・time-box

> 注: 人間認証 (attestation) の署名検証は **CLI では行わない** (verify(web) が Workers API 経由で行う)。analysis レポート (ADR-0009) は advisory で判定には使わない。

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
