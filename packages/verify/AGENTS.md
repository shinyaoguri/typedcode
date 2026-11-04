# packages/verify — AGENTS.md

`@typedcode/verify` は **エクスポート ZIP を独立に検証する Web アプリ**。エディタとは別ドメインでも動くべきで、検証はクライアント側で完結する。

## 責務と境界

- **持つ**: ファイル投入 (drag&drop / FSA API)、Worker 経由のチェーン検証、PoSW 検証、署名済み cp の検証、UI 表示 (タイムライン、チャート、信頼スコア)、差分表示
- **持たない**: イベント生成、proof の改変。**読み取り専用**

## 重要な不変条件

1. **検証は cp の間隔を仮定しない** ([docs/adr/0004-verifier-checkpoint-stance.md](../../docs/adr/0004-verifier-checkpoint-stance.md)): 33 イベントごとでも 100 イベントごとでも 1 cp しかなくても動かなくてはいけない。`shared` 側の `CHECKPOINT_INTERVAL` の値を hard-code しない
2. **未署名 cp の sampling を信頼しない**: 検証成功条件として「サンプリングで OK だった」だけでは不可。フルチェーン検証または署名済み cp の連結検証が前提 (PR #60 のハードニング)
3. **検証 (Web Worker) は決定的**: `workers/verificationWorker.ts` は同じ proof に対して常に同じ結果を返す。乱数 / 時刻 / ネットワーク状態に依存しない。verify は Workers の `/api` を一切呼ばない (署名済み cp の公開鍵は shared の `checkpointKeys` レジストリに同梱。検証側で attestation の署名は照合しない)
4. **マルチタブ proof はタブ毎に独立した `<name>_proof.json` を N 個**として扱い、各タブを個別に検証する (verify-cli は全件検証、verify(web) はタブごと)
5. **i18n キーは型と同期**: `src/i18n/types.ts` の `VerifyTranslationKeys` に新規キーを追加しないと TS2353 が出る
6. **スクリーンショット判定は全軸を `shared` に委譲する** (#212 / #213): per-image は `checkScreenshotImage`、剥ぎ取り (`chainOnly`) は `countChainOnlyImageHashes`、チェーン側ハッシュ集合は `collectChainImageHashes`。web に判定式を書くと verify-cli と結論が食い違う (実際に `chainOnly` が web だけ欠落し、剥ぎ取りが沈黙していた)
7. **`chainImageHashes` は必須引数**: optional にすると渡し忘れが fail-open (チェーン裏付け検査が無効化され、画像と manifest をセットで差し替えた改竄を見逃す) になる。実際に ZIP 経路と結論が割れる事故が起きたので、型で封じてある
8. **入力の種類で「0 枚」と「未検査」を区別する**: ZIP とフォルダは**コンテナ**なので `screenshots/` が無ければ 0 枚 = 剥ぎ取り疑いを見る。proof.json 単体は検査対象が無いので `undefined` = 未検査として issue を上げない (verify-cli の `Screenshots: not checked` と同じ意味論)。両者を混同すると overclaim または誤検知になる
9. **JSZip の `.async(...)` を直接呼ばない** (#234): ZIP エントリの読み出しは shared の `readZipEntryBytes` / `readZipEntryText` に `ZipFileProcessor` が作った `ZipExtractionBudget` を渡して行う。`.async(...)` は申告サイズを無視して最後まで展開するので、サイズを詐称した ZIP で採点者のブラウザが OOM する。`services/__tests__/zipReadPolicy.test.ts` が直接呼び出しを機械的に禁止する (文書ルールだけだった #149 では 6 箇所まで再発した)
10. **拡張子 → 言語の表は shared の `LANGUAGE_MAP` が正本** (#278): `KNOWN_LANGUAGES` (= proof の `language` の allowlist の導出元。#248) もここから導出される。verify に表を書き起こさない。`services/fileUtils.ts` は shared の `getLanguageFromExtension` / `getFileType` / `isProofFilename` を再エクスポートするだけで、`isBinaryFile` だけ「画像は別経路で扱う」ため `isImageFile` 除外を重ねる。`services/__tests__/fileUtilsPolicy.test.ts` が表の再出現を機械的に禁止する
11. **proof の名前 (`*_proof.json` / `*_proof_N.json`, shared の `isProofExportFilename`) なのに読めないファイルは、plaintext / success として並べず error として残す** (#292)。`ZipFileProcessor.parseTextFile` は壊れていても `type: 'proof'` で返し、`FileController.addFileToVerification` が JSON 破損・proof 構造なしを `status: 'error'` のタブ/行にする (検証キューには載せない)。黙って通常の JSON に落とすと壊れたタブが緑の流し見で見落とされ、verify-cli の失敗扱いとも食い違う。`services/__tests__/zipBrokenProof.test.ts` と E2E `verify-web-submission.spec.ts` が固定

12. **同梱ソースと `proof.content` の照合は shared の `matchSubmissionSources` に委譲する** (#293): `FileController` が登録した材料 (フォルダごとの proof・ソース・読めない proof) を、全ファイルが揃ってから `settleSubmission` で照合する (途中で判定すると、まだ読んでいないソースが「欠落」に見える。ZIP は `processFile` の末尾、フォルダは `FolderController` が読み込み後に呼ぶ)。名前の推測 (ベース名の一致) を再び書かない — 同名のタブの 2 つ目 (`main_proof_1.json` ↔ `main_1.c`) が黙って未照合になる (これが旧実装の欠陥だった)。結論は verify-cli と同じ: **不一致・対応の曖昧さは error、ソース欠落・孤立ソースは warning** (`ContentMismatchInfo.severity`。TrustCalculator の `source` issue と `VerificationController.deriveStatus` が同じ軸で見る)。proof のタブに付くのは status と `source` issue だけで、**整合性 (integrity) のバッジは proven のまま**。照合結果は検証が終わった後に付くこともあるので、status の出所は `VerificationController.recomputeStatus` に一本化してある (FileController は `onSubmissionChange` で通知するだけで、status を導出し直さない)。ソースは proof の有無・照合の結果によらず**常に平文タブとして開ける** (不一致のときは行差分ビュー)。比較はバイト厳密なので、ソース候補は BOM を落とさない生バイト (`ParsedFileData.rawBytes`) を持つ。`ui/__tests__/submissionCheck.test.ts` が Web の配線を、`services/__tests__/webCliParity.submission.test.ts` が同じ ZIP での CLI との結論の一致を固定する

## ディレクトリ一覧

| ディレクトリ | 役割 |
|---|---|
| `ui/` | `AppController`, `TabBar`, `ActivityBar`, `StatusBarUI`, `ResultPanel`, `Sidebar`, `AnalysisReportCard` (ADR-0009 の advisory 表示。打鍵動態の旧 `TypingPatternCard` はここに統合済み), `ProcessSummaryCard` (W3 プロセス要約), `ChartEventSelector` |
| `ui/controllers/` | `VerificationController`, `TabController`, `FileController`, `FolderController`, `ChartController` |
| `state/` | `VerificationQueue`, `UIStateManager`, `VerifyTabManager`, `ChartState` |
| `charts/` | `TimelineChart`, `MouseChart`, `IntegratedChart`, `SeekbarController` (Chart.js) |
| `services/` | `FileSystemAccessService`, `FolderSyncManager`, `SyntaxHighlighter`, `TrustCalculator`, `DiffService`, `ChartPreferencesService`, `proofVerification` (shared への委譲アダプタ + 総合判定 / 保証入力の写像) |
| `workers/` | `verificationWorker.ts` (Web Worker のメッセージ入出力のみ。検証は `services/proofVerification` へ) |

## データフロー

```
File Selection (drag&drop / FSA API)
  → FileProcessor (JSON / ZIP)
  → 形式判定 (single / multi: タブ毎に独立 proof)
  → VerificationController → VerificationQueue
  → workers/verificationWorker.ts (Web Worker。メッセージ入出力のみ)
  → services/proofVerification.runProofVerification
     ├─ verifyExamBinding (ADR-0006。package 提供時は**必ず**・verifyProofFile より前。
     │  #218: `proof.exam &&` を条件にすると exam ブロック無しの proof で束縛が黙って無効化される)
     ├─ shared の verifyProofFile (metadata / chain / PoSW / finalHash / content /
     │  checkpoint / 署名済み cp / sessionStartToken 突合 の合成は**すべて shared**)
     └─ runAnalysis (ADR-0009。advisory のみ・valid に不反映・失敗しても検証結果を落とさない)
  → VerificationController.handleComplete (タブ status を決める唯一の場所)
  → TabController.renderResult (TrustCalculator / deriveAssurance)
  → ResultPanel + charts
```

ネットワークには出ない (Workers の `/api` を呼ばない)。人間証明 (attestation) の `signature` は検証しない (検証 API は撤去済み。ADR-0017 / #340。export 前 attestation は #415 で署名自体をやめ、新しい proof は `'unsigned'`、旧 proof の HMAC 値は legacy として読むだけ)。

**Worker 内で検証を再合成しないこと** (#211)。過去にここでレイヤを組み直していたため、
`sessionStartToken` ↔ 署名 cp の sessionId 突合 (spec §6.3) が web だけ欠落し、`chainValid` に
署名 cp の失敗を畳み込んで整合性チップが誤って FAILED になっていた。web↔CLI の結論一致は
`services/__tests__/webCliParity.test.ts` (#216) が CI で固定する — verify-cli の `verifyProof` を
実際に呼んで `valid` / 三層保証 / exam 束縛 / スクショ集計 (tampered・chainOnly) を突き合わせるので、
片側だけ直すと落ちる。スクショの**読込経路** (ZIP vs フォルダ) の一致は `screenshotParity.test.ts` (#212) の担当。

## 状態契約 (data-* 属性)

E2E (`packages/e2e`) は判定を翻訳テキストや色クラスではなく、ここに挙げる **data-\* 属性** で読む ([ADR-0034](../../docs/adr/0034-replace-manual-verification-with-automated-tests.md))。値はすべて生の enum (shared / TrustCalculator / VerificationController の値そのもの) で、翻訳しない。

| 要素 | 属性 | 取りうる値 | 意味 |
|---|---|---|---|
| `#assurance-strip` | `data-integrity` | `proven` / `partial` / `failed` | 三層保証の整合性 (shared `IntegrityLevel`)。`partial` = fast モードで PoSW 未再計算 (#214) |
| `#assurance-strip` | `data-temporal` | `anchored` / `partial` / `unanchored` / `exam-t0` | 時刻アンカー (shared `TemporalLevel`) |
| `#assurance-strip` | `data-pure-typing` | `true` / `false` | 著述性の `provenance.pureTyping` (advisory。判定ではない) |
| `#assurance-strip .assurance-chip` | `data-axis` | `integrity` / `temporal` / `provenance` / `mode` | どの軸のチップか |
| 〃 (`integrity` / `temporal` のチップ) | `data-level` | 上の `data-integrity` / `data-temporal` と同じ値 | チップ単位の判定 |
| 〃 (`provenance` のチップ) | `data-pure-typing` | `true` / `false` | **`data-level` は付けない** (著述性はレベルを持たない。ADR-0009 / ADR-0020) |
| 〃 (`mode` のチップ) | `data-mode` | proof の自己申告 `mode` (`normalizeProofMode` 済み) | 参考表示。保証の導出には使っていない |
| `#result-status-icon` | `data-level` | `verified` / `partial` / `failed` | 総合判定 (`TrustCalculator` の `TrustLevel`) |
| `#trust-issues-list .trust-issue-item` | `data-component` / `data-severity` | `TrustIssueComponent` (`metadata` / `version` / `chain` / `posw` / `screenshots` / `source` / `anchoring` / `exam` / `typing`) / `error` / `warning` | 信頼バッジの issue 1 件。リストは issue が 0 件なら無い。`version` は proof の形式バージョン (#223): `newer` は warning、`tooOld` / `malformed` は error。**`VerificationController` の status と同じ軸** (`newer` → `warning`) |
| `#file-list .file-item` | `data-status` | `pending` / `verifying` / `success` / `warning` / `error` / `cancelled` | ファイルの検証状態。`cancelled` = 利用者が検証をキャンセルした (未検証。判定ではないので `error` と区別し、色も中立色にする。#331) |
| `#file-list .file-item` | `data-filename` | 表示名 | どのファイルの行か |
| `#tabbar .tab` | `data-status` / `data-filename` | `.file-item` と同じ | タブの検証状態 |
| `#tabbar .tab` | `data-active` | `true` (アクティブ時のみ。それ以外は属性なし) | アクティブなタブ (#281) |
| `#file-list .file-item` | `data-active` | `true` (アクティブ時のみ。それ以外は属性なし) | アクティブなファイル行 (#281) |
| `#result-status-card` | `data-filename` | 表示名 | 結果パネルが判定を描画しているファイル (判定を表示していない間は属性なし。#281) |
| `.chart-tab` (`#tab-integrated` / `#tab-timeline` / `#tab-mouse`) | `data-active` | `true` (選択中のみ。それ以外は属性なし) | 結果パネルのチャートタブの選択状態 (#395) |
| `.chart-panel` (`#panel-integrated` / `#panel-timeline` / `#panel-mouse`) | `data-active` | `true` (表示中のみ。それ以外は属性なし) | 表示中のチャートパネル。タブを押せたかは対応するパネルで見る (#395) |
| `#queue-status` | `data-proof-total` / `data-proof-passed` / `data-proof-failed` / `data-proof-cancelled` | 0 以上の整数 (10 進文字列。4 つ同時に付く) | 検証が全件済んだあとのステータスバーの集約 (#282)。total = proof のタブ数 (plaintext・画像は数えない。検証できなかった `*_proof.json` は数える)、passed = status が `success` / `warning` (警告は passed に数える = verify-cli の `valid` と同じ軸)、failed = `error`、cancelled = `cancelled` (passed にも failed にも入れない。「全件済んだ」の判定では済みに数える。#331)。**検証中・proof 0 件・ステータスバーが他の表示 (Ready / エラー / メッセージ) の間は属性なし**。failed > 0 のときだけクリックで最初に失敗した proof を開く |

- **判定を表示していない間は属性を付けない** (`none` などの値は使わない)。検証中 (`startProgress` / `showLoading`)・プレーンテキスト / 画像表示・`reset()`・assurance 無しの描画では `#assurance-strip` の 3 属性と `#result-status-icon` の `data-level` を外す。前のタブの判定が残ると、E2E が別ファイルの判定を読んで通ってしまう。検証自体が失敗したタブ (status `error`・結果なし。未対応形式など) を開いたときも `TabController.showTabContent` が進捗 UI のエラー表示に切り替えるので属性は付かない (以前は何もせず、直前のファイルの判定が残っていた)。E2E は属性が現れるのを待ってから読む
- **キャンセルしたタブ (`cancelled`) を開くと、進捗 UI に「キャンセルした」表示と再検証ボタン (`#vp-retry-btn`) を出す**。判定は無いので `#assurance-strip` / `#result-status-icon` の data-* は付けない。キャンセルボタン (`#vp-cancel-btn`) は表示中のタブが pending / verifying の間だけ出る (#331)
- **ステータスバーの集約 (`services/verificationSummary.summarizeVerification`) の入力はタブの status だけ** (#282)。検証結果から導出し直さない (Sidebar / TabBar と食い違う余地ができ、検証キューに載らない読めない proof が抜ける)。集約を出すのは `AppController.updateStatusBar` の 1 か所で、`StatusBarUI` は `setSummary` 以外の表示に切り替えるたびに data-proof-* を外す
- **`data-status` の出所は `VerificationController` (`tabManager.updateTab` と同じ値を Sidebar / TabBar に流す) に一本化する**。Sidebar / TabBar は受け取った値を出すだけで、検証結果から導出し直さない (`ui/__tests__/fileStatusState.test.ts` が 3 者の一致を固定)
- `#result-status-icon` の `data-level` は `TrustCalculator` の結果を描画したときだけ付ける。`ResultData.trustResult` は必須で、ResultPanel は TrustLevel を導出し直さない
- 属性値は `escapeHtml` を通す (innerHTML 生成。自己申告 `mode` は proof 由来なので特に。#210)
- **active は 4 か所 (TabBar / VerifyTabManager / Sidebar / 結果パネルの表示中ファイル) にあり、タブ・ファイルを閉じた後は `TabController.settleActiveAfterRemoval` で一致させる** (#281)。`handleTabClose` / `removeFile` / `removeFolder` はすべてここを通る。次に選ぶのは TabBar の active (開いているタブだけが候補。未オープンのファイルは選ばない)。開いているタブが 0 件なら Sidebar / VerifyTabManager の active も外す (閉じたファイルを指したまま残さない。#387)。`removeFolder` は子孫フォルダのファイルまで外す (`Sidebar.getFileIdsInFolderTree`。`getFilesInFolder` は直下のみで件数表示用)。`VerifyTabManager.removeTab` はアクティブを消しても自動で別タブに切り替えず active を外すだけ (どれを表示するかは TabController が決める)。`ui/__tests__/tabClose.test.ts` が固定する
- **この契約 (要素・属性名・値域・「無い」の意味) を変えるときは、`packages/e2e` の E2E と同じ PR で変える**。片方だけ変えると E2E が赤になるか、もっと悪いと別の要素を読んで黙って通る。ユニットテストは `ui/__tests__/ResultPanelState.test.ts` / `fileStatusState.test.ts`。E2E 側の読み手は [`packages/e2e/tests/helpers/verifyWeb.ts`](../e2e/tests/helpers/verifyWeb.ts) (`VerifyWebApp`) 1 か所で、[`verify-web-parity.spec.ts`](../e2e/tests/verify-web-parity.spec.ts) (ほか `verify-web-submission` / `verify-web-ui`) が同じ ZIP に対する verify-cli の判定との一致 (Web↔CLI パリティ)、[`production-build.spec.ts`](../e2e/tests/production-build.spec.ts) が本番ビルド (`/verify/`) で属性が出ることを見る
- 検証モードの初期値は URL クエリ `?mode=fast|audit|full` で上書きできる (E2E 用。既定 `full`、不正値は無視。`services/verifyModeQuery.ts`)
- `#file-input` は `multiple`。change の購読は `AppController` の `bindFileInput` 1 か所だけ (WelcomePanel 等は `click()` で開くだけ)。二重購読は `ui/__tests__/fileInput.test.ts` が機械的に禁止する

## 検証キュー (`state/VerificationQueue`)

- Worker は 1 本で、1 件ずつ処理する。待ち行列は **proof のイベント数の少ない順** (同数は到着順。処理中の 1 件は動かさない)。重い proof の後ろで軽い proof の結果が待たされないため (#331)
- `cancel(id)`: 待ち行列から外すか、処理中なら Worker を terminate して作り直して次へ進め、`onCancelled` を呼ぶ (→ `VerificationController.handleCancelled` が `cancelled` を流す)。`remove(id)` は同じ外し方でコールバックを呼ばず、その id のモード・問題パッケージも消す (ファイルを消したとき。`TabController.forgetFile` が呼ぶので、ファイル単体の削除もフォルダごとの削除も通る)
- **パース済みの proof は完了 (result / error / cancel / remove) で手放す**。再検証 (`reverifyWithManifest(id, manifest, proofData)` / キャンセル後の `requeue(id, proofData)`) は**呼び出し側がタブの `proofData` を渡す** (キューに写しを残さない)。`requeue` はいまの既定モードで並べ直す (重い full を止め、fast に切り替えてから再検証する逃げ道)
- 作り直す前の Worker や、処理中でない id から遅れて届いたメッセージは捨てる。`state/__tests__/VerificationQueue.test.ts` が Worker のモックで固定する

## 信頼スコア (`TrustCalculator`)

`TrustCalculator.calculate` は加減点スコアではなく **issue リスト** を組み立て、`determineLevel` で `failed`(error あり) / `partial`(warning あり) / `verified`(issue なし) に落とす。issue を上げる要素:

- **error**: metadata 不正、ハッシュチェーン不正、スクショ改竄、**提出物の不整合 (同梱ソースが `proof.content` と不一致・対応が曖昧。`source` component。#293)**、署名 cp が anchored だが invalid、**セッション開始トークンと署名 cp の sessionId 不一致 (spec §6.3。整合性ではなく `anchoring` 層に上げる)**、**token はあるが検証できない (`rootAnchorFailure`、#329。未登録 keyId / 署名不正 / 端末束縛の不一致。`anchoring` 層に上げ、そのときは root 未アンカーの warning を重ねない。文言は `trust.issueSessionTokenUntrusted.*` で、未登録 keyId のときだけ keyId と「registry が古い可能性」を出す)**、exam 束縛失敗 (package 提供時)
- **warning**: 未アンカー (署名 cp なし)、post-hoc 一括署名疑い、**アンカー密度が疎 (ADR-0016, `signedCheckpointDensity.sparse`)**、**root 未サーバアンカー (ADR-0017, `!rootAnchored` かつ非 exam)**、非ピュアタイピング (ペースト/バルク挿入)、**同梱ソースの欠落 (`source` component)**、`screenShareOptOut`、exam だが問題パッケージ未読込、スクショ欠損

`VerificationController.handleComplete` のタブ status 判定と **同じ軸** を見るので、両者を揃えて変更すること (タブが緑なのに信頼バッジが警告、のような不整合を避ける)。status の error 側は `proofVerification.isOverallValid` (= verify-cli の `valid` と同じ合成: shared の `verifyProofFile` × exam 束縛 × スクショ改竄) 一本に寄せてあるので、error 条件を増やすときは CLI 側も同時に見ること。`component` を増やしたら `ResultPanel.getComponentLabel` にラベルも追加する。#146 で handleComplete にスクショ改竄 (error)・スクショ欠損・`screenShareOptOut` (warning) を合流済み。attestation の署名は検証しないので status 軸にも信頼バッジにも入れない (#340)。

chain issue の `message` は常に翻訳済み文言 (`trust.issueChainInvalid`)。worker の英文 (`verificationResult.message`) は信頼バッジの issue には出さず、技術的な詳細は chain カード (`chainErrorDetails`) に出す (#281)。

スクショの per-image 判定 (ハッシュ突合 + チェーン裏付け) の実体は **shared の `checkScreenshotImage`** (#147)。verify 側で再実装しない — verify-cli と結論が食い違うため。

## よくある罠

- **`finalChainHash` の検証は 2 段**: `proof.finalHash` が記録値、`verifyFinalChainHash` が再計算値。両者一致を確認する
- **File System Access API はブラウザ依存**: Chrome/Edge のみ。フォールバック (`<input type="file">`) を維持
- **チャートのズーム / パン状態は `ChartPreferencesService` で永続化**: 検証結果のリセット時にクリアするか、ユーザー設定として残すかの線引きに注意
- **`tab-switches.json` はチェーン外の平文サイドファイル**: 各タブの proof とは独立で、ハッシュ連鎖に入らず verify / verify-cli も読まない。順序や内容を変えても検証結果は変わらない (監査用の人間向け情報)
- **試験束縛カード (ADR-0006)**: `proof.exam` がある proof は root 束縛を worker が runtime で検証済み (`verifyInitialHashRoot` の exam 分岐。worker は proofData 全体を受け取る)。完全束縛 (署名/復号/内容) は **`.tcexam` を「問題パッケージを読み込む」で取り込んだとき** `verifyExamBinding` で検証 → `VerificationQueue.reverifyWithManifest` で当該タブのみ再検証 (proof はタブの `proofData` を渡す。キューは完了した proof を持っていない)。result-card は**折りたたみ式** (`.result-card-content` は既定 `display:none`、ヘッダクリックで展開) なので、ボタンは展開後に現れる。なお package 未提供 (root 束縛のみ) のカードは **warning (緑にしない) + 既定展開** にしてある (`examBindingCardStatus`。導線を畳みの中に隠さない。#281)

## 分析カード (ADR-0009)

- worker が検証後に shared の `runAnalysis` を実行し `VerificationResultData.analysis` で返す。**advisory であって判定ではない** — `valid` / TrustCalculator / タブ status には一切反映しない (ここを破ると ADR-0009 の直交性が壊れる)
- 表示は `AnalysisReportCard` (`#card-analysis`)。severity (`info`/`notice`/`review`)・score/confidence・summary に加え **evidence (event index) をボタンで出す**
- evidence クリックは `document` に `verify:seek-to-event` CustomEvent を dispatch し、`ChartController` が `SeekbarController.seekTo(eventIndex + 1)` で当該イベント適用後の状態へジャンプする (「シグナルを見る → 現場を検分」の 1 クリック化)
- 分析ロジックは shared に置く。verify 側に分析器を書かない (テストの厚みが shared 側にあるため。verify のユニットテストは #135 で導入済みだが純関数中心)
- **分析できなかった分析器を「シグナルなし」と見せない** (#301): `runAnalysis` は分析器ごとに期限 (shared の `ANALYZER_TIMEOUT_MS` = 10 秒) を付け、throw・期限切れ・不正な出力を `AnalysisReport.analyzerStatus` に残して resolve する。解決しない分析器があっても検証結果は期限後に返る。カードは `analysisAvailability` で `complete` / `partial` / `unavailable` を決め、カードの `data-analysis-availability` (状態契約) に出す。`unavailable` (ok の分析器が 0) はバッジを「分析不能」(warning)、`partial` は注記を出し、分析器の一覧に status (`data-analyzer-status`) と message を出す。「分析シグナルなし」は `complete` のときだけ。message と id は外部分析器が決められる未信頼の文字列なので `escapeHtml` を通す。`runProofVerification` の `analyzers` / `analysisTimeoutMs` はテストの継ぎ目 (本番は渡さない)。全滅のとき `summarizeAnalysisForAssurance` が undefined を返し、著述性の signal 数も null になる

## 三層保証バッジ (ADR-0020)

- 結果画面最上部の `#assurance-strip` に **整合性 / 時刻アンカー / 著述性** の 3 チップ (+ 自己申告 mode の参考チップ) を出す。導出は shared の `deriveAssurance` (**verify 側で再実装しない** — CLI と食い違うため)
- 導出は `TabController.renderResult` で行う (スクショ改竄数を持つのがこの層だけのため)。入力は実証拠のみで **自己申告 `proof.mode` は使わない**。`AssuranceInput` への写像は `proofVerification.buildAssuranceInput` に切り出してあり、verify-cli の同じ写像との一致をパリティテストが固定する (#216)
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
