# @typedcode/verify-cli

TypedCode のタイピング証明ファイルを検証するコマンドラインツールです。

## インストール

現状 npm には**未公開**です。モノレポ内でビルドして使います:

```bash
npm run build:verify-cli
node packages/verify-cli/dist/cli.js <proof-file>
```

> 以降の例では `typedcode-verify` をコマンド名として表記しますが、公開前は `node packages/verify-cli/dist/cli.js` に読み替えてください。公開後は `npm install -g @typedcode/verify-cli` / `npx typedcode-verify` を予定。

`dist/cli.js` は `@typedcode/shared` ごと 1 ファイルにまとめた ESM bundle で (#298)、素の Node.js (>= 24) だけで動きます。tsx などの TypeScript 実行環境は不要で、`dist/cli.js` を単体で別の場所へ持ち出しても動作します。

## 使い方

```bash
# 単一の JSON ファイルを検証
typedcode-verify proof.json

# スクリーンショット付き ZIP を検証
typedcode-verify proof.zip

# 複数ファイルを指定 (すべて検証し、オプションは全入力に適用)
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

# 受理ポリシー (#296): 署名 cp が 1 件も無い proof / 最終イベントまで署名が届いていない proof を fail させる
typedcode-verify ALL_TC.zip --require-signed-checkpoints
typedcode-verify ALL_TC.zip --require-final-anchor   # 短時間の試験向け (下の注意を参照)

# 外部 Analyzer を差し込む (ADR-0023。反復可。既定の分析器に追加される)
typedcode-verify proof.zip --analyzer ./my-analyzer.mjs

# 既定の分析器を外して外部のみ使う (--analyzer が最低 1 つ必要)
typedcode-verify proof.zip --analyzer ./my-analyzer.mjs --no-default-analyzers

# 分析結果を機械可読に書き出す
typedcode-verify ALL_TC.zip --analysis-json out.json      # {filename, valid, policy, analysis}
typedcode-verify ALL_TC.zip --analysis-bundle bundle.json # content-free な派生バンドル (ADR-0024 Tier A)

# 採点に使うソースを取り出す (proof ごとに submitted / verified / report.json を書く)
typedcode-verify ALL_TC.zip --extract-sources graded/
```

### オプション一覧

| オプション | 説明 |
|---|---|
| `--mode <full\|fast\|audit>` | 検証モード (既定 `full`)。`fast` は PoSW 反復をスキップ、`audit` は現状 `full` と同等 |
| `--exam-package <file.tcexam>` | 試験束縛を完全検証 (ADR-0006) |
| `--submitted-at <ISO>` | 提出時刻。time-box (提出期間内か) を判定 |
| `--require-anchor-density` | アンカー密度が疎な proof を exit 1 にする (ADR-0016) |
| `--require-root-anchor` | root 未アンカーの proof を exit 1 にする (ADR-0017) |
| `--require-signed-checkpoints` | 署名 cp が 1 件も無い proof を exit 1 にする (#296) |
| `--require-final-anchor` | 最終イベントが署名 cp に覆われていない (未署名の末尾がある) proof を exit 1 にする (#296)。長いセッションでは使わない ([受理ポリシー](#受理ポリシー---require-)) |
| `--analyzer <module>` | 外部 Analyzer モジュールを読み込む (反復可、ADR-0023) |
| `--no-default-analyzers` | 同梱の分析器を外し、`--analyzer` で指定したものだけを使う |
| `--analysis-json <out.json>` | 分析レポートを JSON でファイル出力 |
| `--analysis-bundle <out.json>` | content-free な派生バンドルを出力 (ADR-0024 Tier A) |
| `--extract-sources <dir>` | ZIP の proof ごとに、同梱ソースと `proof.content` を `<dir>` へ書き出す ([書き出し](#ソースの書き出し---extract-sources)) |
| `--help`, `-h` | 使い方を表示 |

未知のオプションや値の欠落はエラーになります (`--require-root-anchr` のようなタイポでゲートが黙って無効化されるのを防ぐため)。

### 外部 Analyzer (ADR-0023)

TypedCode は「判定するツール」ではなく「多様な分析手法を載せる基盤」です。採点者・研究者は CLI を**フォークせず**、自前の分析器を差し込めます。

- `--analyzer <module>` に、ADR-0009 の Analyzer 契約を `default` / `analyzer` / `analyzers` で export する ES モジュールのパスを渡します (反復可)
- 既定では同梱の分析器に**追加**されます。`--no-default-analyzers` を付けると外部のみになります
- 分析結果は **advisory** で、**exit code には一切影響しません**。渡される検証結果は凍結済みで、書き換えようとすると分析器側で例外になります (他の分析器は止まりません)
- 分析器は**ハンドルを残さないでください** (タイマー・ソケット・開いたままのファイル)。CLI は終了コードを立てたあとイベントループが空になるのを待って終了するため、残ったハンドルはプロセスの終了を妨げます
- 分析器ごとに **10 秒の期限** があります (変更するオプションはありません)。期限までに返らない分析器は `timeout`、例外を投げた分析器は `failed`、契約に合わない出力 (配列でない戻り値、未知の severity、有限でない score / confidence、配列でない evidence、文字列でない summary) は `invalid-output` として記録され、他の分析器と検証結果の出力は続きます。期限の後に返ってきた結果は捨てます。契約に合わない signal だけが捨てられ、合う signal は残ります
- 分析できなかった分析器は `--- Analysis (advisory) ---` に `Analysis unavailable: boom (failed), hang (timeout)` の形で出ます。`No analysis signals.` は全分析器が正常に終わって signal が 0 件のときだけ出ます。`--analysis-json` / `--analysis-bundle` の `analysis.analyzerStatus` に分析器ごとの状態 (`ok` / `failed` / `timeout` / `invalid-output`) が入ります。どの分析器も正常に終わらなかったときは、Assurance の Authorship 行に signal 数と `review N%` を出しません (「手掛かりなし」と区別するため)
- 期限は非同期の待ちにしか効きません。**同期の無限ループ (`for (;;) {}`) は止まりません** — 外部分析器は信頼済みのコードとして扱う前提です

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

複数 proof を含む ZIP では各 `*_proof.json` を順に検証し、末尾に `=== Summary: N/M proofs passed ===` を出します (1 件でも失敗すれば exit 1)。入力を複数渡したときも同様で、全入力の全 proof を検証して末尾に Summary を出します。存在しない・壊れている・未対応拡張子の入力は、他の入力の検証を止めずに失敗として数え (Summary では `✗`、エラーは stderr)、1 件でもあれば exit 1 です。複数入力のときの ZIP 内 proof は `<入力>:<エントリ名>` で表示し、`--analysis-json` / `--analysis-bundle` の `filename` も同じ名前になります (読み込めなかった入力は分析が無いので載りません)。`--mode fast` のときは PoSW 行が `SKIPPED (fast mode)`、署名 cp が無いときは `Anchoring: unavailable` になります。

`Anchoring` 行の下には**アンカー密度** (ADR-0016) の `Density: max gap … events / …s, first anchor @ event …` が出ます。署名 cp が主張セッションに対して疎な場合 (例: 末尾 1 個だけで長いチェーンをアンカー) は `! Anchoring is sparse …` の警告が付きます。既定は警告のみですが、`--require-anchor-density` を付けると疎な proof を **exit 1** にできます (採点向け opt-in)。

### 受理ポリシー (`--require-*`)

`--require-root-anchor` / `--require-anchor-density` / `--require-signed-checkpoints` / `--require-final-anchor` は、改ざんの検出 (整合性) とは別に、採点者が「この proof を受理するか」の条件を足す受理ポリシーです (ADR-0043)。どれも既定は off で、立てなければ結論も出力も変わりません。

- 1 つでも立てると、出力に `--- Acceptance policy ---` 節が出ます。立てた要件 (`Applied:`)、結果 (`Result: all requirements met` / `N requirement(s) not met`)、違反ごとに `FAIL <code>: <理由>` の行が並びます。code は `root-anchor-missing` / `anchor-density-sparse` / `signed-checkpoints-missing` / `terminal-anchor-missing` (未署名の末尾の件数つき) です
- 違反があれば exit 1 ですが、`Metadata` / `Hash Chain` は `PASS` のままで、改ざんとは区別できます。逆に、改ざんなどで検証そのものが失敗した proof ではポリシーを評価せず、`Result: not evaluated (verification failed)` と出します
- `--analysis-json` の各要素に `policy` (`applied` / `evaluated` / `violations`) が入ります。`--analysis-bundle` には入りません
- 違反した proof があっても、残りの入力の検証と `--analysis-*` の書き出しは続きます
- `--require-anchor-density` は署名 cp が 0 件の proof を対象にしません (署名 cp の存在を求めるのは `--require-signed-checkpoints`)。密度が疎な proof は `Anchoring: VERIFIED` と `! Anchoring is sparse` の警告のまま、受理ポリシーの違反として exit 1 になります
- 提出期間 (time-box) と LMS の受領時刻はポリシーに含みません (ADR-0013)

> **注意: `--require-final-anchor` は、署名 token の再取得 (#236(b)) が入るまで、短時間の試験以外で常用しないでください。** 長い課題のセッションでは、token の期限切れなどで最終イベントへの署名を取れないことがあり、改ざんしていない正直な提出が不受理 (exit 1) になりえます。

## 終了コード

| Code | 説明 |
|------|-------------|
| 0 | 検証成功 |
| 1 | 検証失敗 / エラー (ZIP の同梱ソースが `proof.content` と一致しない場合を含む) |

既定は 1 (fail-closed) です。0 になるのは全 proof の検証を最後まで終えて合格したときと `--help` だけで、外部 Analyzer が解決しないまま止まる等で途中で終わった場合も 1 になります (#315)。

### 複数の提出物を並列に検証する

CLI は渡された入力を 1 件ずつ順に検証します (並列実行のオプションはありません)。PoSW を再計算する `full` は 1 イベントあたり約 9 ms かかるので、提出物が多いときは `xargs -P` でプロセスを並べてください。入力ごとにログと exit code を分けておくと、どの提出物が落ちたかを後から拾えます (まとめて 1 プロセスに渡すと exit code は全体で 1 つになります)。

```bash
# submissions/ の ZIP を 4 並列で検証し、入力ごとに logs/<名前>.log と logs/<名前>.exit を残す
mkdir -p logs
find submissions -name '*.zip' -print0 |
  xargs -0 -P 4 -I {} sh -c '
    name=$(basename "$1" .zip)
    typedcode-verify "$1" > "logs/$name.log" 2>&1
    echo $? > "logs/$name.exit"
  ' _ {}

# exit code が 0 でなかった (= 検証失敗かエラー) 入力
grep -L '^0$' logs/*.exit
```

exit code の意味は上の表と同じです (0 = その入力の全 proof が合格、1 = 失敗かエラー)。並列数はコア数とメモリ (ZIP 1 件ぶんを展開して持つ) に合わせて決めてください。

## 提出物の照合 (ZIP の同梱ソース)

ZIP 入力では、proof ごとに、同梱されたソースが `proof.content` (検証済みの本文) と**バイト単位で一致するか**を照合し、結果を `--- Submission ---` 節に出します。proof を検証しても、同梱ソースが同じ内容である保証にはならないためです (採点するソースが、検証したものとずれます)。

```
--- Submission ---
Source:      valid.js  MISMATCH (differs from proof.content)
  source 32 bytes, proof.content 1 bytes, first difference at byte 0
```

| 表示 | 意味 | exit code |
|---|---|---|
| `MATCH` | 期待名のソースが `proof.content` とバイト単位で一致 | 影響なし |
| `MISMATCH` | 期待名のソースが `proof.content` と違う | **1** |
| `AMBIGUOUS` | 対応するソースを一意に決められない (読めない proof や欠番が先にある、期待名が他の proof と衝突) | **1** |
| `UNCHECKABLE` | proof に `filename` / `content` が無く、比較できない。ZIP にソースがあるときだけ失敗 | ソースがあれば **1** |
| `MISSING` | 期待名のソースが ZIP に無い (警告) | 影響なし |
| `! Source file not matched to any proof` | どの proof の期待名にも当たらないソース (警告。`--- Submission (ZIP) ---` 節) | 影響なし |

- **対応規則**: 期待名は proof の `filename` と `language` から、editor の export と同じ手順で作ります (同名のタブは `_proof` / `_proof_1`… の順に `main.c` / `main_1.c`…)。名前の推測や、内容が一致する別名のソースの探索はしません。詳細は [system-spec §5.2.1](../../docs/system-spec.md)
- **比較は厳密一致**: 改行 (CRLF / LF)・BOM・末尾の空白・Unicode 正規化は**正規化しません**
- `Integrity: PROVEN` は変わりません。proof 自体は改ざんされていないので、提出物の不整合は整合性の判定ではなく、総合の合否 (exit 1) と `Submission failed:` の行に出ます
- JSON 単体の入力は同梱ソースが無いので `Submission: not checked` と出ます
- **採点に使うのは、`MATCH` したソースか、`proof.content` です**。`MISMATCH` したソースは採点に使わないでください。同梱ソースは ZIP を展開すればそのまま読めるので、不一致のときも元のソースは失われません

## ソースの書き出し (`--extract-sources`)

`--extract-sources <dir>` を付けると、ZIP 入力の proof ごとに `<dir>/<proof のベース名>/` を作って 3 つを書きます (`<proof のベース名>` は proof の ZIP 内ファイル名から `.json` とフォルダを除いたもの。`main_proof.json` なら `main_proof`)。

```
graded/
└── main_proof/
    ├── submitted.c    # ZIP に同梱されていたソースの原文バイト (期待名で対になったもの)
    ├── verified.c     # proof.content (検証済みの本文)
    └── report.json    # 照合の状態と検証結果の要約
```

| ファイル | 内容 | 書かれる条件 |
|---|---|---|
| `submitted.<ext>` | 同梱ソースの原文バイト (BOM・改行もそのまま) | 照合が `match` または `mismatch` のとき。`MISSING` / `AMBIGUOUS` / `UNCHECKABLE` のときは書かない (他の proof のソースをこの proof の提出物として見せないため) |
| `verified.<ext>` | `proof.content` | チェーン (Hash Chain / Metadata) が検証に通ったとき。改ざんされた proof の本文は「検証済み」の名では出さない |
| `report.json` | `submission` (`status` は `match` / `mismatch` / `missing-source` / `ambiguous` / `uncheckable`)、`files`、`verification` (`valid` / `chainValid` / `metadataValid` / `integrity` / `errorMessage`) | 常に |

- **不一致でも検証失敗でも `submitted` は書きます**。コードの回収を、検証の結論に妨げさせないためです。`MISMATCH` のときは `submitted.<ext>` (提出されたもの) と `verified.<ext>` (proof が記録していたもの) が別のファイルとして並びます。採点に使うのは `match` した `submitted` か `verified` です
- **元のソースを上書きしません**: 入力の ZIP は読むだけです。書き出し先のファイルは排他的に作成し、`<dir>/<名前>/` が既にあるときはその proof を**書かずにエラー** (exit 1) にします (再実行しても黙って別名を作りません)。シンボリックリンクも辿りません
- **`<dir>` の外には書きません**: ディレクトリ名は ZIP エントリ名から、`<ext>` は期待されるソース名 (proof の `filename` / `language` から作った名前) から作りますが、どちらも改ざんされうる値なので、最後のパス区切りより後ろだけを取り、文字・数字・`._-` 以外は `_` に置き換え、先頭の `.` を除きます。`../x` や絶対パスは書き出し先を動かせません。拡張子が英数字でなければ `txt` になります
- 複数の入力が同じ名前のエントリ (`main_proof.json` など) を持つときは、同じ実行の 2 つ目以降に `_2`, `_3`… を付けます。元のエントリは `report.json` の `input` / `proofEntry` に残ります
- 書き出しの失敗 (既存のディレクトリ・書き込み権限など) は exit 1 です。それ以外で exit code は変わりません (検証・照合の規約のとおり)
- JSON 単体の入力には同梱ソースが無いので、警告を出して何も書きません。孤立ソース (どの proof にも対にならなかったファイル) は書き出しません。ZIP を展開して読んでください

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
7. **試験束縛検証** (ADR-0006): `proof.exam` があれば root 束縛 (自己完結) を検証し、`--exam-package` 指定時は署名・packageHash・問題内容ハッシュ・time-box まで検証する。**`--exam-package` を渡したのに `exam` ブロックが無い proof は invalid (exit 1)** — 採点ゲートを黙って無効化させない (#218)

**形式バージョンのゲート** (#223): proof の `version` が `MIN_SUPPORTED_VERSION` 未満・`MAJOR.MINOR.PATCH` 以外・欠落のとき、`Error:` に version の理由を出して **exit 1** にします。この検証器が知る major を超える `version` (例 `2.0.0`) は reject せず、合否の直下に `! proof format version … is newer than this verifier supports` の warning を出します (exit code は他の検査で決まります。意味が変わったフィールドを旧規則で読んでいる恐れがあるので、最新の verify-cli で確かめ直してください)。`--exam-package` の `.tcexam` が未知の `formatVersion` のときは、形式不正とは別の文言 (新しい形式なら最新の verify-cli を使う旨) を stderr に出して exit 1 です。

> 注: HMAC アテステーションの署名検証は **CLI でも verify(web) でも行いません** (現在どのクライアントからも実行されていない dead な経路です)。人間ゲートの暗号的な証拠は **セッション開始トークン** (ADR-0017) が担い、公開鍵レジストリだけで**オフライン検証**されます (`--require-root-anchor` 参照)。analysis レポート (ADR-0009) は advisory で判定には使いません。

検証はすべてオフラインで完結します (ネットワークアクセスなし)。

## ビルド

```bash
npm run build      # 型検査 (tsc --noEmit) + esbuild で dist/cli.js に bundle
npm run dev        # watch モード (esbuild)
npm run test:dist  # build 済みの dist/cli.js を素の node で叩く smoke test
```

ビルドは `scripts/build.mjs` (esbuild) が `src/cli.ts` を起点に shared・jszip などの依存をすべて取り込んだ単一の `dist/cli.js` を出力します。`--analyzer` で渡す外部モジュールは実行時に読み込まれるので bundle には含まれません。

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

版は各パッケージの `package.json` を参照してください (README には書き写しません)。

| パッケージ | 用途 |
|---------|---------|
| @typedcode/shared | コア型と検証ロジック (ZIP 処理を含む) |
