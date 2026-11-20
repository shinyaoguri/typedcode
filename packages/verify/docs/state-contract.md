# packages/verify — 状態契約 (data-* 属性) の全表

[AGENTS.md](../AGENTS.md)「状態契約 (data-* 属性)」の表と本文。E2E が読む要素・属性・値域はここが正本で、変えるときは `packages/e2e` の E2E と同じ PR で変える。

E2E (`packages/e2e`) は判定を翻訳テキストや色クラスではなく、ここに挙げる **data-\* 属性** で読む ([ADR-0034](../../../docs/adr/0034-replace-manual-verification-with-automated-tests.md))。値はすべて生の enum (shared / TrustCalculator / VerificationController の値そのもの) で、翻訳しない。

| 要素 | 属性 | 取りうる値 | 意味 |
|---|---|---|---|
| `#assurance-strip` | `data-integrity` | `proven` / `partial` / `failed` | 三層保証の整合性 (shared `IntegrityLevel`)。`partial` = fast モードで PoSW 未再計算 (#214) |
| `#assurance-strip` | `data-temporal` | `anchored` / `partial` / `unanchored` / `exam-t0` | 時刻アンカー (shared `TemporalLevel`) |
| `#assurance-strip` | `data-pure-typing` | `true` / `false` | 著述性の `provenance.pureTyping` (advisory。判定ではない) |
| `#assurance-strip .assurance-chip` | `data-axis` | `integrity` / `temporal` / `provenance` / `mode` | どの軸のチップか |
| 〃 (`integrity` / `temporal` のチップ) | `data-level` | 上の `data-integrity` / `data-temporal` と同じ値 | チップ単位の判定 |
| 〃 (`provenance` のチップ) | `data-pure-typing` | `true` / `false` | **`data-level` は付けない** (著述性はレベルを持たない。ADR-0009 / ADR-0020) |
| 〃 (`mode` のチップ) | `data-mode` | proof の自己申告 `mode` (`normalizeProofMode` 済み) | 参考表示。保証の導出には使っていない |
| `#exam-starter-row` | `data-starter` | `matched` / `mismatch` / `not-evaluated` | 試験束縛の starter 照合 (shared `ExamStarterCheck.status`。#718)。package 未提供・束縛の前段で失敗したときは行を隠す (照合済みと出さない) |
| `#exam-language-row` | `data-language-check` | `allowed` / `not-allowed` / `not-evaluated` | 試験束縛の許可言語の照合 (shared `ExamLanguageCheck.status`。#727)。隠す条件は starter の行と同じ。proof.language は提出時の言語の申告 |
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
- **ステータスバーの集約 (`services/verificationSummary.summarizeVerification`) の入力はタブの status だけ** (#282)。検証結果から導出し直さない (Sidebar / TabBar と食い違う余地ができ、検証キューに載らない読めない proof が抜ける)。集約を出すのは `AppController.updateStatusBar` (表示の決め方は `ui/statusBarView.renderStatusBar`) の 1 か所で、`StatusBarUI` は `setSummary` 以外の表示に切り替えるたびに data-proof-* を外す。**操作の知らせ (フォルダを開いた・監視でファイルが変わった) は `statusBar.setMessage` で直接出さず `onStatusBarUpdate(message)` に渡す** (#683): 集約を出せるときは集約が優先される。集約を出し直す契機は検証の完了だけなので、検証が先に終わった後に知らせで上書きすると集約が消えたまま残る (`ui/__tests__/folderStatusSummary.test.ts`)
- **`data-status` の出所は `VerificationController` (`tabManager.updateTab` と同じ値を Sidebar / TabBar に流す) に一本化する**。Sidebar / TabBar は受け取った値を出すだけで、検証結果から導出し直さない (`ui/__tests__/fileStatusState.test.ts` が 3 者の一致を固定)
- `#result-status-icon` の `data-level` は `TrustCalculator` の結果を描画したときだけ付ける。`ResultData.trustResult` は必須で、ResultPanel は TrustLevel を導出し直さない
- 属性値は `escapeHtml` を通す (innerHTML 生成。自己申告 `mode` は proof 由来なので特に。#210)
- **active は 4 か所 (TabBar / VerifyTabManager / Sidebar / 結果パネルの表示中ファイル) にあり、タブ・ファイルを閉じた後は `TabController.settleActiveAfterRemoval` で一致させる** (#281)。`handleTabClose` / `removeFile` / `removeFolder` はすべてここを通る。次に選ぶのは TabBar の active (開いているタブだけが候補。未オープンのファイルは選ばない)。開いているタブが 0 件なら Sidebar / VerifyTabManager の active も外す (閉じたファイルを指したまま残さない。#387)。`removeFolder` は子孫フォルダのファイルまで外す (`Sidebar.getFileIdsInFolderTree`。`getFilesInFolder` は直下のみで件数表示用)。`VerifyTabManager.removeTab` はアクティブを消しても自動で別タブに切り替えず active を外すだけ (どれを表示するかは TabController が決める)。`ui/__tests__/tabClose.test.ts` が固定する
- **この契約 (要素・属性名・値域・「無い」の意味) を変えるときは、`packages/e2e` の E2E と同じ PR で変える**。片方だけ変えると E2E が赤になるか、もっと悪いと別の要素を読んで黙って通る。ユニットテストは `ui/__tests__/ResultPanelState.test.ts` / `fileStatusState.test.ts`。E2E 側の読み手は [`packages/e2e/tests/helpers/verifyWeb.ts`](../../e2e/tests/helpers/verifyWeb.ts) (`VerifyWebApp`) 1 か所で、[`verify-web-parity.spec.ts`](../../e2e/tests/verify-web-parity.spec.ts) (ほか `verify-web-submission` / `verify-web-ui`) が同じ ZIP に対する verify-cli の判定との一致 (Web↔CLI パリティ)、[`exam-roundtrip.spec.ts`](../../e2e/tests/exam-roundtrip.spec.ts) が `#exam-load-btn` から `.tcexam` を渡したあとの `data-temporal` (`exam-t0`) と CLI の一致 (#229)、[`production-build.spec.ts`](../../e2e/tests/production-build.spec.ts) が本番ビルド (`/verify/`) で属性が出ることを見る
- 検証モードの初期値は URL クエリ `?mode=fast|audit|full` で上書きできる (E2E 用。既定 `full`、不正値は無視。`services/verifyModeQuery.ts`)
- `#file-input` は `multiple`。change の購読は `AppController` の `bindFileInput` 1 か所だけ (WelcomePanel 等は `click()` で開くだけ)。二重購読は `ui/__tests__/fileInput.test.ts` が機械的に禁止する
