# packages/verify-cli — 分析層・三層保証・プロセス要約の出力

`--- Analysis (advisory) ---`・`--- Assurance ---`・`--- Process summary ---` の出力と、`--analysis-*` / `--result-json` / `--aggregate-bundle` / `--analyzer` を触るときに読む。[AGENTS.md](../AGENTS.md) から移した節。

## 分析層の出力 (ADR-0009)

- 検証 (`--- Checks ---`) と**直交する advisory** を `--- Analysis (advisory) ---` セクションに出す。判定ではない (**exit code には一切影響させない** — ここを破ると ADR-0009 の直交性が壊れる)
- 各 signal は severity (`INFO`/`NOTICE`/`REVIEW`) + summary + **evidence (event index)** を出す。evidence は人間が当該イベントを検分するためのリンクで ADR-0009 上必須
- `--analysis-json <out.json>` (任意): 全 proof 分の `{filename, valid, policy, analysis}` を JSON でファイル出力する (`policy` は受理ポリシーの結果。ADR-0043)。分析器の評価ハーネス / コホート集計の機械可読な入口 (Phase 8 W5)。advisory のみで exit code 非干渉
- `--result-json <out.json>` (任意, #588): 入力ごと・proof ごとの検証の結論 `{filename, valid, integrityValid, failedCheck, errorMessage, rootAnchored, temporal, policyViolations}` を JSON でファイル出力する。e2e が stdout の文言ではなく **「どの検査で落ちたか」(`failedCheck`)** を assert するための口。`failedCheck` は `resultJson.ts` の純関数 `deriveFailedCheck` が `FullVerificationResult` のフィールドから導く列挙 (`unreadable` / `version` / `root` / `metadata` / `chain` / `finalHash` / `checkpoint` / `content` / `rootAnchor` / `sessionToken` / `policy` / `other`。valid は null)。複数の検査が同時に落ちたときは、`deriveFailedCheck` の**診断の優先順位**で代表 1 つを選ぶ (version → root / metadata → chain・finalHash・checkpoint・content → rootAnchor → sessionToken → 署名 cp → policy → other。定義は `resultJson.ts` のコメント、固定は `resultJson.test.ts` の `... beats ...` / `... wins over every other failure`)。**検査の実行順で最初に落ちたものでも、`errorMessage` の先頭の文言と同じものでもない** (例: nonce の書き換えは `errorMessage` がハッシュ不一致の文言で `failedCheck` は `root`。token の失敗は Layer 1 で決まるがチェーンの失敗より後に選ぶ)。優先順位は `errorMessage` の順 (shared の `verificationError`) に沿わせてあるので、shared の順を変えたら `resultJson.ts` と `resultJson.test.ts` も直す。`--analysis-json` と違い読めなかった入力 (ZIP 内の壊れた proof・未対応拡張子・検証中の例外) も `unreadable` で載る。`valid` は CLI の gate 込みの総合 (exit code の元と同じ値)、`integrityValid` は受理ポリシーと gate を足す前の shared の値。advisory のみで exit code 非干渉
- `--analysis-bundle <out.json>` (任意, ADR-0024 Tier A): 全 proof 分の **content-free な派生バンドル** `{filename, schema, notice, integrityValid, processSummary, analysis, assurance}` を出力する。**events / ソース / fingerprint を含まない** (Tier A)。ただしファイル名・`reflectionNotes`・分析器の自由記述を含むので**授業内レビュー用で学外へ共有しない** (README に開示。ADR-0024 Amendment)。ファイル名は外さない (既存の採点運用)。コホート基準 (ADR-0025) の入力フォーマット。組み立ては shared の `buildAnalysisBundle` に委譲 (CLI は result の content-free な派生物を渡すだけ)。advisory のみで exit code 非干渉。`integrityValid` は **gate 込みの総合 valid ではなく `assurance.integrity !== 'failed'`** (`toBundleIntegrityValid`, #219) — 契約は「整合性検証を通ったか」で、ADR-0031 の `'partial'` (検査を省略した) を失敗に潰さない
- `--aggregate-bundle <out.json>` (任意, ADR-0024 Tier S, #304): 全 proof 分の集計バンドルを出力する。中身は shared の `toAggregateBundle` が Tier A から **allowlist で 1 項目ずつ**書き出した数値とカテゴリだけ。**`filename` を足さない** (Tier A と違う。ZIP のエントリ名に学籍番号や氏名が入りうる)。CLI 側で spread や項目の追加をしない — 出す項目を変えるときは shared の `aggregateBundle.ts` と ADR-0024 Amendment を直す。`cliAggregateBundle.test.ts` が、外部 analyzer・ファイル名・reflectionNote に詰めた `SECRET-*` の不在と、入力の sha256 が変わらないことを実プロセスで固定する。advisory・exit code 非干渉
- `--analyzer <module>` (任意・反復可) / `--no-default-analyzers` (ADR-0023 / プラットフォーム方針): 採点者/研究者の**外部 Analyzer** (ADR-0009 契約を default / `analyzer` / `analyzers` で export する ES モジュール) を**フォークせず**差し込む。既定では同梱分析器に**追加**、`--no-default-analyzers` で既定を外して外部のみ。読込は `src/analyzers.ts` の `loadExternalAnalyzers` (動的 import + 契約バリデーション + 重複 id 拒否) で、**分析ロジックは外部モジュール側**。`runAnalysis(input, analyzers)` に渡すだけ。advisory のみで exit code 非干渉。**注意**: 任意モジュールを動的 import する = 任意コード実行。信頼できるモジュールのみ
- 分析ロジックは shared の `runAnalysis` に委譲。**CLI 側に分析器を書かない** (`--analyzer` も読込 I/O のみで中身は外部)
- **分析できなかった分析器は `Analysis unavailable: <id> (<status>), ...` に出す** (#301): shared の `runAnalysis` が分析器ごとに期限 (`ANALYZER_TIMEOUT_MS` = 10 秒、CLI オプションは足さない) を付け、throw・期限切れ・不正な出力を `analysis.analyzerStatus` に残す。解決しない Promise を返す `--analyzer` でも、期限後に検証結果を最後まで出して exit code を返す (`cliExitProcess.test.ts` が実時間 10 秒で固定)。`No analysis signals.` は全分析器が ok で 0 件のときだけ。id と message は `safe()` を通す。ok の分析器が 0 なら Assurance の Authorship に signal 数と `review N%` を出さない (`summarizeAnalysisForAssurance` が undefined)。期限は非同期の待ちにしか効かず、同期の無限ループは止まらない (外部分析器は信頼済みコードの前提、README に明記)。`VerifyProofOptions.analysisTimeoutMs` はテストの継ぎ目

## 三層保証サマリ (ADR-0020)

- ヘッダ直下に `--- Assurance ---` (Integrity / Timeline / Authorship) を出す。導出は shared の `deriveAssurance` に委譲 (CLI 側で再実装しない)
- Authorship は常に `ADVISORY` 表記 — 判定に見せない (ADR-0009/0020)。exit code にも不干渉

## プロセス要約 (Phase 8 W3)

- `--- Process summary ---` に作業時間・挿入/削除・実行/停止/離脱/外部入力と見どころ (event index 付き) を出す。中立な記述で判定に影響しない
- 抽出は shared の `summarizeProcess` に委譲 (CLI 側で再実装しない)
