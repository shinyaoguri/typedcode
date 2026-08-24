# packages/verify-cli — CLAUDE.md

`@typedcode/verify-cli` は **Node.js から proof ZIP / JSON を検証する CLI**。CI / バッチ / 自動化用途。

## 責務と境界

- **持つ**: JSON / ZIP の解析、チェーン検証 (`@typedcode/shared` の `verifyProofFile` を使う)、PoSW 検証、署名済み cp 検証、結果の整形と終了コード
- **持たない**: 独自の暗号ロジック (すべて `shared` に委譲)、UI (verify 側)、proof 生成 (editor 側)

## 動作要件

- **Node.js ≥24** (`engines` で強制)
- ルート `package.json` engines `>=24` と同じ。`.node-version` は `24.4.1`、GitHub Actions も `node-version: '24'`

## 重要な不変条件

1. **`shared` の検証ロジックを再実装しない**: バグや暗号アルゴリズムの修正は shared 側で行う。CLI 側で差分があると 「Web で OK / CLI で NG」 のような不整合事故が起きる
2. **終了コード**: 0 = 成功、1 = 失敗 / エラー。これが CI で利用されるので変えない。**立て方は `process.exitCode` で、`process.exit()` は使わない** (#283): stdout がパイプのとき Node の書き込みは非同期なので、`process.exit()` は未 flush の出力を捨ててプロセスを落とす。60 proof の ZIP を遅い読み手 (`| tee` / `| less`) へ流すと **ちょうど 65536 バイト (パイプバッファ 1 個分) で行の途中から切れ、`=== Summary: N/M proofs passed ===` ごと消える**ことを実測済み。TTY 実行とファイル redirect では再現しないので、気付かずに再導入しやすい (`exitCode.test.ts` が `process.exit(` の再導入を落とす)。副作用として `--analyzer` の外部モジュールがハンドルを残すと自然終了できなくなるので、README に明記してある
3. **ZIP 内の proof は全件検証する**: exam/class はタブ毎に独立した `<name>_proof.json` を N 個出力するので、`shared` の `extractAllProofsFromZip` で全件を取り出し、**1 件でも fail なら exit 1**。最初の 1 件だけ見ると未検証タブが exit 0 で通る (proof 判定は構造 `isProofFile` で、ファイル名順や `screenshots/manifest.json` に依存しない)
4. **stdout は人間向け、stderr はエラーログ**: パイプして grep される可能性を考慮
5. **proof / ZIP 由来の文字列は `output.ts` の `safe()` を通してから stdout へ出す** (#266): 生値のままだと改行と ANSI エスケープで**任意の行を偽造できる** (ZIP エントリ名から Summary に緑の `✓ <正規ファイル名>` を生やせることを再現済み)。exit code は守られるので壊れるのは grep する採点運用と端末表示。`safe()` が保証するのは「未信頼値が 1 行に収まり行頭を乗っ取れない」ところまで — 行内に `Hash Chain:  PASS` という**文字列**が残るのは防げないので、**採点は行頭を固定して** grep する。整形を `cli.ts` の `console.log` に直接書かない (テストを当てられなくなる。`formatProofHeader` / `formatMultiSummary` のように `output.ts` へ寄せる)

## ファイル構成

```
src/
├── cli.ts         # エントリポイント
├── verify.ts      # 検証ロジック (shared を呼ぶ薄いラッパ)
├── output.ts      # 結果の整形
├── progress.ts    # 進捗表示
└── zip.ts         # ZIP 処理
```

## よくある罠

- **`@typedcode/shared` の `main` は `src/index.ts` (raw TypeScript)**: tsc コンパイル後の `dist/cli.js` を `node` で直接実行すると `ERR_MODULE_NOT_FOUND` が出る。これは pre-existing でモノレポ内ローカル実行時の構成課題。**Node のバージョンとは無関係**。公開時にはバンドルが必要 (将来課題)
- **新しい proof フォーマットへの対応**: shared 側で `parseJsonString` / `parseZipBuffer` を拡張すれば CLI もそのまま追従する。CLI 側に判定ロジックを書かない
- **進捗表示は TTY 検出**: パイプ先や CI ログでは ANSI エスケープを抑制する

## 試験モード (ADR-0006) の検証

- `--exam-package <file.tcexam>` (任意): 指定すると shared の `verifyExamBinding` で署名→packageHash→root→内容ハッシュ→time-box まで完全検証する。**未指定でも** `proof.exam` のある proof は root 束縛 (自己完結) を検証し「package 未提供」を明示する
- `--submitted-at <ISO>` (任意): time-box の `withinWindow` 判定 (Moodle 提出時刻)。未指定なら window 表示のみ
- package 指定で束縛失敗は **exit 1**。exam 束縛のみ失敗時は出力ヘッダに束縛理由を出す (chain の成功メッセージを誤表示しない)
- **`--exam-package` を渡したら `exam` ブロックの無い proof も必ず束縛検証にかける** (#218)。呼び出し側で `proof.exam &&` を条件にすると、casual proof が何も検証されないまま exit 0 で通る (採点ゲートのサイレント無効化)。判定は shared の `verifyExamBinding` が fail-closed (`reason: 'Proof has no exam block'`) で持つので、CLI はそこへ**到達させる**だけ。ZIP では per-proof に失敗させる (不変条件 3 と同型)
- **束縛が「対象外の proof」で落ちても `integrity` は落とさない**: これはゲートの誤用であって改ざんではない (ADR-0020 の語彙)。`deriveAssurance` へ渡す `exam.present` を固定値 `true` にしないこと
- `--submitted-at` は time-box (advisory) 専用。`--exam-package` 無しでは効かないので warning を出す (exit code は変えない)
- ロジックは全て shared (`verifyExamBinding` / `parseExamPackageManifest`) に委譲。CLI は薄いラッパに留める

## スクリーンショット検証 (#147)

- ZIP 入力のとき、`screenshots/manifest.json` の entry と画像バイト列を突合し、さらにチェーンの `screenshotCapture.imageHash` (改ざん不能な唯一の真正記録) との裏付けを検査する。判定は **shared の `summarizeScreenshotArtifacts` / `checkScreenshotImage`** (verify web と同一実装) — CLI 側で再実装しない
- **改ざん (tampered) は exit 1** (web の error 軸 / integrity failed と同じ結論)。欠損・chainOnly (チェーンに記録があるのに manifest に無い = 剥ぎ取り疑い) は warning のみで exit 非干渉
- チェーンが健全でスクショだけ改ざんのときは、出力ヘッダに改ざん枚数を出す (#217)。exam 束縛のみ失敗と同型で、chain の成功メッセージを `Error:` として誤表示しない (両方落ちたときは両方出す)
- JSON 単体入力は画像が無いので未検査 — 出力に `Screenshots: not checked` を明示する (overclaim 防止)
- サマリは ZIP 単位で一度だけ計算し全 proof に共有する (スクショはセッション単位で proof 横断)。`deriveAssurance` へは `screenshotsTampered` として渡る

## アンカー密度 gate (ADR-0016)

- `--require-anchor-density` (任意・boolean): 署名 cp が「主張したイベント数 / 経過時間」に対して**疎**な proof を **exit 1** にする (採点向け opt-in)。既定は warning のみで `Anchoring` 行の下に `! Anchoring is sparse …` を出す
- 判定は shared の `verifySignedCheckpoints` (`requireAnchorDensity`) に委譲。CLI は `verifyProofFile` にフラグを通すだけ。閾値 (cadence×5) も shared 側が単一ソース
- 末尾 1 個の署名 cp で長いチェーンをアンカーする手口を捕捉する (`coverageRatio` は 1.0 でも疎)。**非破壊** (proof フォーマット不変)

## root アンカー gate (ADR-0017)

- `--require-root-anchor` (任意・boolean): root がサーバアンカーされていない (`sessionStartToken` 無し = オフライン劣化 / 旧 proof) proof を **exit 1** にする (採点向け opt-in)。既定は warning のみで `Root anchor: unanchored` を出す。**exam proof の免除は束縛が検証済み (`--exam-package` で `verifyExamBinding` 合格) のときのみ** (#131) — 自己申告の exam ブロックだけでは gate を回避できない
- 判定は shared の `verifyProofFile` (`requireRootAnchor` + `examBindingVerified`) に委譲。CLI は `verifyExamBinding` を先に実行して結果フラグを通すだけ。proof は `PROOF_FORMAT_VERSION` 1.2.0 (`MIN_SUPPORTED` 1.0.0 据置) なので **旧 proof もそのまま検証**でき、`rootAnchored:false` で受理 (後方互換)

## 分析層の出力 (ADR-0009)

- 検証 (`--- Checks ---`) と**直交する advisory** を `--- Analysis (advisory) ---` セクションに出す。判定ではない (**exit code には一切影響させない** — ここを破ると ADR-0009 の直交性が壊れる)
- 各 signal は severity (`INFO`/`NOTICE`/`REVIEW`) + summary + **evidence (event index)** を出す。evidence は人間が当該イベントを検分するためのリンクで ADR-0009 上必須
- `--analysis-json <out.json>` (任意): 全 proof 分の `{filename, valid, analysis}` を JSON でファイル出力する。分析器の評価ハーネス / コホート集計の機械可読な入口 (Phase 8 W5)。advisory のみで exit code 非干渉
- `--analysis-bundle <out.json>` (任意, ADR-0024 Tier A): 全 proof 分の **content-free な派生バンドル** `{filename, schema, integrityValid, processSummary, analysis, assurance}` を出力する。**events / ソース / fingerprint を含まない** (Tier A)。コホート基準 (ADR-0025) の入力フォーマット。組み立ては shared の `buildAnalysisBundle` に委譲 (CLI は result の content-free な派生物を渡すだけ)。advisory のみで exit code 非干渉。`integrityValid` は **gate 込みの総合 valid ではなく `assurance.integrity !== 'failed'`** (`toBundleIntegrityValid`, #219) — 契約は「整合性検証を通ったか」で、ADR-0031 の `'partial'` (検査を省略した) を失敗に潰さない
- `--analyzer <module>` (任意・反復可) / `--no-default-analyzers` (ADR-0023 / プラットフォーム方針): 採点者/研究者の**外部 Analyzer** (ADR-0009 契約を default / `analyzer` / `analyzers` で export する ES モジュール) を**フォークせず**差し込む。既定では同梱分析器に**追加**、`--no-default-analyzers` で既定を外して外部のみ。読込は `src/analyzers.ts` の `loadExternalAnalyzers` (動的 import + 契約バリデーション + 重複 id 拒否) で、**分析ロジックは外部モジュール側**。`runAnalysis(input, analyzers)` に渡すだけ。advisory のみで exit code 非干渉。**注意**: 任意モジュールを動的 import する = 任意コード実行。信頼できるモジュールのみ
- 分析ロジックは shared の `runAnalysis` に委譲。**CLI 側に分析器を書かない** (`--analyzer` も読込 I/O のみで中身は外部)

## 三層保証サマリ (ADR-0020)

- ヘッダ直下に `--- Assurance ---` (Integrity / Timeline / Authorship) を出す。導出は shared の `deriveAssurance` に委譲 (CLI 側で再実装しない)
- Authorship は常に `ADVISORY` 表記 — 判定に見せない (ADR-0009/0020)。exit code にも不干渉

## プロセス要約 (Phase 8 W3)

- `--- Process summary ---` に作業時間・挿入/削除・実行/停止/離脱/外部入力と見どころ (event index 付き) を出す。中立な記述で判定に影響しない
- 抽出は shared の `summarizeProcess` に委譲 (CLI 側で再実装しない)
