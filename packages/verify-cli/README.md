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

# 検証モード (full | fast | audit。既定 full)
typedcode-verify proof.zip --mode fast

# 試験モード (ADR-0006): 問題パッケージ (.tcexam) を渡して束縛を完全検証
typedcode-verify ALL_TC.zip --exam-package p1.tcexam
# 提出時刻を渡すと time-box (提出期間内か) も判定
typedcode-verify ALL_TC.zip --exam-package p1.tcexam --submitted-at 2026-06-06T01:00:00Z

# アンカー密度 gate (ADR-0016): 署名 cp が疎な proof を fail させる (採点向け opt-in)
typedcode-verify ALL_TC.zip --require-anchor-density

# root アンカー gate (ADR-0017): root 未アンカー (serverNonce トークン無し) を fail させる (採点向け opt-in)
typedcode-verify ALL_TC.zip --require-root-anchor

# 外部 Analyzer を差し込む (ADR-0023。反復可。既定の分析器に追加される)
typedcode-verify proof.zip --analyzer ./my-analyzer.mjs

# 既定の分析器を外して外部のみ使う (--analyzer が最低 1 つ必要)
typedcode-verify proof.zip --analyzer ./my-analyzer.mjs --no-default-analyzers

# 分析結果を機械可読に書き出す
typedcode-verify ALL_TC.zip --analysis-json out.json      # {filename, valid, analysis}
typedcode-verify ALL_TC.zip --analysis-bundle bundle.json # content-free な派生バンドル (ADR-0024 Tier A)
```

### オプション一覧

| オプション | 説明 |
|---|---|
| `--mode <full\|fast\|audit>` | 検証モード (既定 `full`)。`fast` は PoSW 反復をスキップ、`audit` は現状 `full` と同等 |
| `--exam-package <file.tcexam>` | 試験束縛を完全検証 (ADR-0006) |
| `--submitted-at <ISO>` | 提出時刻。time-box (提出期間内か) を判定 |
| `--require-anchor-density` | アンカー密度が疎な proof を exit 1 にする (ADR-0016) |
| `--require-root-anchor` | root 未アンカーの proof を exit 1 にする (ADR-0017) |
| `--analyzer <module>` | 外部 Analyzer モジュールを読み込む (反復可、ADR-0023) |
| `--no-default-analyzers` | 同梱の分析器を外し、`--analyzer` で指定したものだけを使う |
| `--analysis-json <out.json>` | 分析レポートを JSON でファイル出力 |
| `--analysis-bundle <out.json>` | content-free な派生バンドルを出力 (ADR-0024 Tier A) |
| `--help`, `-h` | 使い方を表示 |

未知のオプションや値の欠落はエラーになります (`--require-root-anchr` のようなタイポでゲートが黙って無効化されるのを防ぐため)。

### 外部 Analyzer (ADR-0023)

TypedCode は「判定するツール」ではなく「多様な分析手法を載せる基盤」です。採点者・研究者は CLI を**フォークせず**、自前の分析器を差し込めます。

- `--analyzer <module>` に、ADR-0009 の Analyzer 契約を `default` / `analyzer` / `analyzers` で export する ES モジュールのパスを渡します (反復可)
- 既定では同梱の分析器に**追加**されます。`--no-default-analyzers` を付けると外部のみになります
- 分析結果は **advisory** で、**exit code には一切影響しません**

> ⚠️ `--analyzer` は指定したモジュールを動的 import します = **任意コード実行**。信頼できるモジュールのみを渡してください。

### 分析結果の書き出し

| フラグ | 出力内容 |
|---|---|
| `--analysis-json <out.json>` | proof ごとの `{filename, valid, analysis}`。分析器の評価ハーネスやコホート集計の入口 |
| `--analysis-bundle <out.json>` | proof ごとの `{filename, schema, integrityValid, processSummary, analysis, assurance}`。**events / ソースコード / fingerprint を含まない** content-free な派生ビュー (ADR-0024 Tier A) |

どちらも advisory で exit code には影響しません。

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

`Anchoring` 行の下には**アンカー密度** (ADR-0016) の `Density: max gap … events / …s, first anchor @ event …` が出ます。署名 cp が主張セッションに対して疎な場合 (例: 末尾 1 個だけで長いチェーンをアンカー) は `! Anchoring is sparse …` の警告が付きます。既定は警告のみですが、`--require-anchor-density` を付けると疎な proof を **exit 1** にできます (採点向け opt-in)。

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

> 注: HMAC アテステーションの署名検証は **CLI でも verify(web) でも行いません** (現在どのクライアントからも実行されていない dead な経路です)。人間ゲートの暗号的な証拠は **セッション開始トークン** (ADR-0017) が担い、公開鍵レジストリだけで**オフライン検証**されます (`--require-root-anchor` 参照)。analysis レポート (ADR-0009) は advisory で判定には使いません。

検証はすべてオフラインで完結します (ネットワークアクセスなし)。

## ビルド

```bash
npm run build      # ビルド
npm run dev        # watch モード
```

## アーキテクチャ

```
src/
├── cli.ts         # CLI エントリポイント
├── args.ts        # 引数・フラグの解析と検証 (純関数)
├── verify.ts      # 検証ロジック (shared を呼ぶ薄いラッパ)
├── analyzers.ts   # 外部 Analyzer の読み込みと契約バリデーション
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
