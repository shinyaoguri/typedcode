# packages/verify-cli — AGENTS.md

`@typedcode/verify-cli` は **Node.js から proof ZIP / JSON を検証する CLI**。CI / バッチ / 自動化用途。

## 責務と境界

- **持つ**: JSON / ZIP の解析、チェーン検証 (`@typedcode/shared` の `verifyProofFile` を使う)、PoSW 検証、署名済み cp 検証、結果の整形と終了コード
- **持たない**: 独自の暗号ロジック (すべて `shared` に委譲)、UI (verify 側)、proof 生成 (editor 側)

## 動作要件

- **Node.js ≥24** (`engines` で強制)
- ルート `package.json` engines `>=24` と同じ。`.node-version` は `24.22.2`、GitHub Actions も `node-version: '24'`

## 重要な不変条件

1. **`shared` の検証ロジックを再実装しない**: バグや暗号アルゴリズムの修正は shared 側で行う。CLI 側で差分があると 「Web で OK / CLI で NG」 のような不整合事故が起きる
2. **終了コード**: 0 = 成功、1 = 失敗 / エラー。これが CI で利用されるので変えない。**立て方は `process.exitCode` で、`process.exit()` は使わない** (#283): stdout がパイプのとき Node の書き込みは非同期なので、`process.exit()` は未 flush の出力を捨ててプロセスを落とす。60 proof の ZIP を遅い読み手 (`| tee` / `| less`) へ流すと **ちょうど 65536 バイト (パイプバッファ 1 個分) で行の途中から切れ、`=== Summary: N/M proofs passed ===` ごと消える**ことを実測済み。TTY 実行とファイル redirect では再現しないので、気付かずに再導入しやすい (`exitCode.test.ts` が `process.exit(` の再導入を落とす)。副作用として `--analyzer` の外部モジュールがハンドルを残すと自然終了できなくなるので、README に明記してある。**`exitCode` の既定は 1 (fail-closed, #315)**: `main()` の先頭で `process.exitCode = 1` を立て、0 に下ろすのは成功の集計 (`summary.every(...)`) と `--help` だけ。自然終了が正規経路なので、集計にも catch にも届かずに終わったプロセスは既定値で終わる — 既定 0 だと、解決しない Promise を返す analyzer (悪意でもバグでも) 1 つで改ざん proof が `Loading proof file...` のまま exit 0 になる (再現済み)。新しい早期 return を足すときも 0 を立てない限り失敗のままになる向きを保つ (`exitCode.test.ts` が位置を、`cliExitProcess.test.ts` が実プロセスの終了コードを固定)
3. **ZIP 内の proof は全件検証する**: exam/class はタブ毎に独立した `<name>_proof.json` を N 個出力するので、`shared` の `extractAllProofsFromZip` で全件を取り出し、**1 件でも fail なら exit 1**。最初の 1 件だけ見ると未検証タブが exit 0 で通る (proof 判定は構造 `isProofFile` で、ファイル名順や `screenshots/manifest.json` に依存しない)。**ただし proof の命名 `*_proof.json` / `*_proof_N.json` (`isProofExportFilename`) に当たるのに読めないファイル (JSON 破損・proof 構造なし) は `extractAllProofsFromZip` が `failures` で返し、CLI は失敗として数える** (#292。かつては黙って捨てて、壊れたタブが未検証のまま PASS / exit 0 になった)。ヘッダにファイル名と理由を出し、他の proof の検証・`--analysis-*` は止めない。壊れた proof しか無い ZIP も「proof 無し」ではなく破損として報告する。命名に当たらない JSON (`tab-switches.json` / `screenshots/manifest.json` / 設定) は従来どおり無視。`cliZipBrokenProof.test.ts` が固定
4. **stdout は人間向け、stderr はエラーログ**: パイプして grep される可能性を考慮
5. **proof / ZIP 由来の文字列は `output.ts` の `safe()` を通してから stdout へ出す** (#266): 生値のままだと改行と ANSI エスケープで**任意の行を偽造できる** (ZIP エントリ名から Summary に緑の `✓ <正規ファイル名>` を生やせることを再現済み)。exit code は守られるので壊れるのは grep する採点運用と端末表示。`safe()` が保証するのは「未信頼値が 1 行に収まり行頭を乗っ取れない」ところまで — 行内に `Hash Chain:  PASS` という**文字列**が残るのは防げないので、**採点は行頭を固定して** grep する。整形を `cli.ts` の `console.log` に直接書かない (テストを当てられなくなる。`formatProofHeader` / `formatMultiSummary` のように `output.ts` へ寄せる)
6. **位置引数の入力は全件検証する** (#294): `positional[0]` だけを処理すると `valid.json broken.json` が未検証のまま exit 0 になり、順序を入れ替えると結論が変わった。入力ごとの読込・パース・未対応拡張子・ZIP 内 proof 無しは全体を落とさず、summary に `valid: false` として積んで残りの入力へ進む (1 件でも失敗なら exit 1)。複数入力のときの ZIP 内 proof の表示名 (= `--analysis-*` の `filename`) は `<入力>:<エントリ名>`。`--exam-package` などのオプションは全入力に共通。`cliInputs.test.ts` が固定

7. **ZIP の同梱ソースは `proof.content` と照合し、不一致は exit 1** (#293): proof を検証しても、同梱ソースが検証済みの内容と同じである保証にはならない (かつては content `x` の proof に `THIS IS NOT THE VERIFIED CONTENT` のソースを同梱しても `PASSED` / `Integrity: PROVEN` / exit 0 だった)。対応規則と照合は **shared の `matchSubmissionSources`** (verify Web と同一実装。再実装しない)。CLI が持つのは `--- Submission ---` 節の出力 (`output.ts`、名前は `safe()`) と、結論を総合 `valid` に畳むところだけ。守ること: ① 不一致・`ambiguous` は **valid=false (exit 1)** だが **`assurance` (Integrity) は落とさない** (proof は改ざんされていない。ADR-0020 の語彙、#218 の「ゲート誤用で integrity を落とさない」と同型)。`valid` を落とすのは `cli.ts` の 1 か所で、`--analysis-json` の `valid` にも同じ値を使う ② 欠落 (`MISSING`)・孤立ソースは警告で exit 非干渉。JSON 単体入力は `Submission: not checked` を明示する ③ **期待名は proof の `filename` / `language` から作る。内容が一致する別名のソースを探して割り当てない** (本物を `valid_1.js`、偽物を期待名 `valid.js` に置かれると通ってしまう) ④ 比較はバイト厳密 (改行・BOM を正規化しない)。ZIP のソース取り出しは BOM を落とさないよう生バイト (`extractSubmissionSourcesFromZip`) で行う。`cliSubmission.test.ts` (実プロセス) と shared の `submissionSources.test.ts` が固定する。`--extract-sources` (submitted と verified の書き出し) は不変条件 8

8. **`--extract-sources` は元のソースを上書きせず、`<dir>` の外に書かない** (#409): ZIP の proof ごとに `<dir>/<proof のベース名>/` へ `submitted.<ext>` (同梱ソースの原文バイト)・`verified.<ext>` (`proof.content`)・`report.json` を書く。実装は `src/extractSources.ts` で、`cli.ts` は検証の結果 (または `verifyProof` の例外) を渡すだけ。守ること: ① **上書きしない**: ファイルは `open(path, 'wx')` (O_EXCL。既存・シンボリックリンクのどちらも失敗する)、ディレクトリは非 recursive の `mkdir` で、既存なら**その proof は何も書かずに失敗**させる (再実行で黙って別名を作らない)。入力 ZIP は読むだけ。`wx` と `mkdir` の組を `w` / recursive に緩めない (`extractSources.test.ts` と `cliExtractSources.test.ts` が固定) ② **`<dir>` の外に書かない**: ディレクトリ名は ZIP エントリ名、拡張子は期待ソース名 (proof の `filename` / `language` 由来) から作る。どちらも攻撃者が書けるので `sanitizeEntryName` (最後のパス区切りより後ろだけ・文字種を `\p{L}\p{N}\p{M}._-` に絞る・先頭末尾の `.` を除く・予約名と空を置換・長さを切る) と `sanitizeExtension` (英数字のみ、外れたら `txt`) を通し、さらに書く直前に解決したパスが `<dir>` の直下かを確かめる。名前の組み立てをこの 2 関数の外へ出さない ③ 同じ実行で名前が衝突したら (複数 ZIP の同名エントリ。大文字小文字を区別しない) `createDirNamer` が `_2`… を付ける ④ **`submitted` は対にできた `match` / `mismatch` だけ**、**`verified` はチェーンが検証に通った proof だけ** (名前が「検証済み」を約束する)。検証失敗・不一致でも submitted は書く (コード回収を検証の結論に妨げさせない。#300) ⑤ 書き出しは**検証の判定を変えない**: exit code を動かすのは書き出し自体の失敗 (exit 1) だけ。`valid` や `assurance` に書き出しの結果を混ぜない。対応規則 (`matchSubmissionSources`) と ZIP の読み出し (shared の予算付きリーダー経由の `extractSubmissionSources`) は再実装・再読込しない

## ファイル構成

```
scripts/
└── build.mjs      # esbuild で dist/cli.js (単一 ESM) に bundle (#298)
src/
├── cli.ts         # エントリポイント
├── verify.ts      # 検証ロジック (shared を呼ぶ薄いラッパ)
├── extractSources.ts  # --extract-sources の名前の無害化と書き出し (#409)
├── output.ts      # 結果の整形
├── progress.ts    # 進捗表示
└── zip.ts         # ZIP 処理
```

## よくある罠

- **build は esbuild による単一 ESM bundle** (#298, `scripts/build.mjs`): `@typedcode/shared` の `main` は `src/index.ts` (raw TypeScript、中の import は `.js` 拡張子の bundler 解決前提) なので、tsc の出力を `node` で起動すると shared の解決で `ERR_MODULE_NOT_FOUND` になる (Node のバージョンとは無関係)。shared を JS 生成に変えると editor / verify / workers の Vite 解決と PoSW Worker の URL に波及するので、**CLI 側で shared ごと `dist/cli.js` 1 ファイルに取り込む**。`tsc` は型検査専用 (`build` は `tsc --noEmit && node scripts/build.mjs`)。**`dev` / `build` を `tsc` の emit に戻さない** (dist が素の node で起動しなくなる)。ESM bundle には `require` が無いので `createRequire` の banner を付けてある (CJS 依存が Node builtin を動的 `require` した時点で落ちる罠の防御)。`--analyzer` の外部モジュールは実行時の動的 import なので bundle に入らない
- **配布物の smoke は `npm run test:dist`** (`distSmoke.test.ts` / `vitest.dist.config.ts`): build 後に `dist/` だけを一時ディレクトリへ写し、素の node で `--help` / 有効 proof / 壊れた proof / `--analyzer` を叩く。`dist/cli.js` が無ければ fail。通常の `test:run` からは除外 (build していない環境で壊さないため) — CI の check job が build 直後に回す。tsx で `src/cli.ts` を起動するテスト (`cliExitProcess.test.ts`、e2e) では配布物の解決は確かめられない
- **有効 proof の fixture** (`src/__tests__/fixtures/proofs/valid.json`) は実 PoSW 付き。proof フォーマットが変わって通らなくなったら同じディレクトリの `generate-valid.mts` で作り直す
- **新しい proof フォーマットへの対応**: shared 側で `parseJsonString` / `parseZipBuffer` を拡張すれば CLI もそのまま追従する。CLI 側に判定ロジックを書かない
- **進捗表示は TTY 検出**: パイプ先や CI ログでは ANSI エスケープを抑制する

## 試験モード (ADR-0006) の検証

- `--exam-package <file.tcexam>` (任意): 指定すると shared の `verifyExamBinding` で署名→packageHash→root→内容ハッシュ→識別子照合→time-box まで完全検証する。**未指定でも** `proof.exam` のある proof は root 束縛 (自己完結) を検証し「package 未提供」を明示する
- **識別子は束縛合格時のみ検証済み** (#273): `CLIExamResult` の `examId` / `problemId` / `variant` は、束縛が合格したときだけ shared の `verifiedIds` (署名済み manifest 側の値) になり `identifiersVerified: true`。package 未提供・束縛失敗では proof の自己申告値のままで `identifiersVerified: false`、`Exam:` 行に `(self-reported)` を付ける。**検証済みに見せない**ことが不変条件で、表示値は従来どおり `safe()` を通す
- `--submitted-at <ISO>` (任意): time-box の `withinWindow` 判定 (Moodle 提出時刻)。未指定なら window 表示のみ
- package 指定で束縛失敗は **exit 1**。exam 束縛のみ失敗時は出力ヘッダに束縛理由を出す (chain の成功メッセージを誤表示しない)
- **`--exam-package` を渡したら `exam` ブロックの無い proof も必ず束縛検証にかける** (#218)。呼び出し側で `proof.exam &&` を条件にすると、casual proof が何も検証されないまま exit 0 で通る (採点ゲートのサイレント無効化)。判定は shared の `verifyExamBinding` が fail-closed (`reason: 'Proof has no exam block'`) で持つので、CLI はそこへ**到達させる**だけ。ZIP では per-proof に失敗させる (不変条件 3 と同型)
- **束縛が「対象外の proof」で落ちても `integrity` は落とさない**: これはゲートの誤用であって改ざんではない (ADR-0020 の語彙)。`deriveAssurance` へ渡す `exam.present` を固定値 `true` にしないこと
- `--submitted-at` は time-box (advisory) 専用。`--exam-package` 無しでは効かないので warning を出す (exit code は変えない)
- ロジックは全て shared (`verifyExamBinding` / `parseExamPackageManifestResult`) に委譲。CLI は薄いラッパに留める。`.tcexam` の取込は理由つきの `parseExamPackageManifestResult` を使い、未知の `formatVersion` (新旧) と形式不正を出し分ける (null を返す旧 `parseExamPackageManifest` は使わない。#223)
- **proof の形式バージョン (#223)**: 判定 (`versionStatus`) は shared の `verifyProofFile` が持つ。CLI は `newer` を合否の直下の warning として出し (exit code には干渉しない)、`tooOld` / `malformed` は `errorMessage` を `Error:` に出す。**自己申告の `proof.version` は生で stdout に出さず**、`verify.ts` が `parseVersionStrict` で数字に正規化した `declaredVersion` だけを使う (shared AGENTS.md 不変条件 11)

## スクリーンショット検証 (#147)

- ZIP 入力のとき、`screenshots/manifest.json` の entry と画像バイト列を突合し、さらにチェーンの `screenshotCapture.imageHash` (改ざん不能な唯一の真正記録) との裏付けを検査する。判定は **shared の `summarizeScreenshotArtifacts` / `checkScreenshotImage`** (verify web と同一実装) — CLI 側で再実装しない
- **改ざん (tampered) は exit 1** (web の error 軸 / integrity failed と同じ結論)。欠損・chainOnly (チェーンに記録があるのに manifest に無い = 剥ぎ取り疑い) は warning のみで exit 非干渉
- チェーンが健全でスクショだけ改ざんのときは、出力ヘッダに改ざん枚数を出す (#217)。exam 束縛のみ失敗と同型で、chain の成功メッセージを `Error:` として誤表示しない (両方落ちたときは両方出す)
- JSON 単体入力は画像が無いので未検査 — 出力に `Screenshots: not checked` を明示する (overclaim 防止)
- サマリは ZIP 単位で一度だけ計算し全 proof に共有する (スクショはセッション単位で proof 横断)。`deriveAssurance` へは `screenshotsTampered` として渡る

## 受理ポリシー (ADR-0043)

- 4 つの opt-in 要件を受理ポリシーとして評価する: `--require-root-anchor` (`root-anchor-missing`) / `--require-anchor-density` (`anchor-density-sparse`) / `--require-signed-checkpoints` (`signed-checkpoints-missing`) / `--require-final-anchor` (`terminal-anchor-missing`。未署名の末尾の件数つき)。判定は shared の `evaluateAcceptancePolicy` (`verifyProofFile` が呼ぶ) に委譲し、CLI はフラグを通すだけ。**CLI に判定式を書かない**
- 結果は整合性 (`integrityValid`) と違反 (`policy.violations`) に分かれて返る。総合 `valid` (= exit code) は `integrityValid && violations が空`。整合性が落ちた proof ではポリシーを評価しない (`policy.evaluated: false`)
- 出力は、フラグを 1 つでも立てたときだけ `--- Acceptance policy ---` 節を出す。**フラグ無しの出力は変えない** (既定のポリシーは空 = 従来どおりの結論。不足は warning のまま)。`--analysis-json` の各要素にも `policy` を載せる。`--analysis-bundle` (Tier A) には載せない (content-free な派生物で、ポリシーは採点側の設定)
- 違反した proof も、他の入力の検証と `--analysis-*` / `--extract-sources` を止めない (不変条件 6 の経路)
- time-box (`--submitted-at`) と LMS の受領時刻はポリシーに入れない (ADR-0013 の advisory のまま)
- `--require-final-anchor` は #236(b) (署名 token の再取得) の着地前は、短時間の試験以外で常用しない (README に明記)

## アンカー密度 gate (ADR-0016)

- `--require-anchor-density` (任意・boolean): 署名 cp が「主張したイベント数 / 経過時間」に対して**疎**な proof を **exit 1** にする (採点向け opt-in)。既定は warning のみで `Anchoring` 行の下に `! Anchoring is sparse …` を出す
- 判定は shared の受理ポリシー (ADR-0043、`anchor-density-sparse`) に委譲。CLI は `verifyProofFile` にフラグを通すだけ。閾値 (cadence×5) は shared の `computeDensity` が単一ソース。密度不足は `signedCheckpoints.valid` を落とさない (Anchoring 行は `VERIFIED` + `! Anchoring is sparse`、Acceptance policy 節に違反)。cp が 0 件の proof は対象外 (`density: null`)。cp の存在を求めるのは `--require-signed-checkpoints`
- 末尾 1 個の署名 cp で長いチェーンをアンカーする手口を捕捉する (`coverageRatio` は 1.0 でも疎)。**非破壊** (proof フォーマット不変)

## root アンカー gate (ADR-0017)

- `--require-root-anchor` (任意・boolean): root がサーバアンカーされていない (`sessionStartToken` 無し = オフライン劣化 / 旧 proof) proof を **exit 1** にする (採点向け opt-in)。既定は warning のみで `Root anchor: unanchored` を出す。token はあるが検証できない proof (`rootAnchorFailure`、#329) は既定で exit 1 (整合性は落とさない) で、`Root anchor: UNTRUSTED (<理由>)` を出す (`no session start token` と出さない。keyId は `safe()` を通す)。gate を立てていても Error 行は token の失敗理由を優先する。**exam proof の免除は束縛が検証済み (`--exam-package` で `verifyExamBinding` 合格) のときのみ** (#131) — 自己申告の exam ブロックだけでは gate を回避できない
- 判定は shared の `verifyProofFile` (`requireRootAnchor` + `examBindingVerified`) に委譲 (受理ポリシーの `root-anchor-missing`。ADR-0043)。CLI は `verifyExamBinding` を先に実行して結果フラグを通すだけ。proof は `PROOF_FORMAT_VERSION` 1.2.0 (`MIN_SUPPORTED` 1.0.0 据置) なので **旧 proof もそのまま検証**でき、`rootAnchored:false` で受理 (後方互換)

## 分析層の出力 (ADR-0009)

- 検証 (`--- Checks ---`) と**直交する advisory** を `--- Analysis (advisory) ---` セクションに出す。判定ではない (**exit code には一切影響させない** — ここを破ると ADR-0009 の直交性が壊れる)
- 各 signal は severity (`INFO`/`NOTICE`/`REVIEW`) + summary + **evidence (event index)** を出す。evidence は人間が当該イベントを検分するためのリンクで ADR-0009 上必須
- `--analysis-json <out.json>` (任意): 全 proof 分の `{filename, valid, policy, analysis}` を JSON でファイル出力する (`policy` は受理ポリシーの結果。ADR-0043)。分析器の評価ハーネス / コホート集計の機械可読な入口 (Phase 8 W5)。advisory のみで exit code 非干渉
- `--result-json <out.json>` (任意, #588): 入力ごと・proof ごとの検証の結論 `{filename, valid, integrityValid, failedCheck, errorMessage, rootAnchored, temporal, policyViolations}` を JSON でファイル出力する。e2e が stdout の文言ではなく **「どの検査で落ちたか」(`failedCheck`)** を assert するための口。`failedCheck` は `resultJson.ts` の純関数 `deriveFailedCheck` が `FullVerificationResult` のフィールドから導く列挙 (`unreadable` / `version` / `root` / `metadata` / `chain` / `finalHash` / `checkpoint` / `content` / `rootAnchor` / `sessionToken` / `policy` / `other`。valid は null)。**優先順位は `verifyProofFile` が `errorMessage` に採る順 (最初に落ちた層) と揃える**。shared の評価順を変えたら `resultJson.ts` と `resultJson.test.ts` も直す。`--analysis-json` と違い読めなかった入力 (ZIP 内の壊れた proof・未対応拡張子・検証中の例外) も `unreadable` で載る。`valid` は CLI の gate 込みの総合 (exit code の元と同じ値)、`integrityValid` は受理ポリシーと gate を足す前の shared の値。advisory のみで exit code 非干渉
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
