# packages/editor — ディレクトリとデータフロー

どこに何があるかと、記録・export の流れ。[AGENTS.md](../AGENTS.md) から移した節で、守るべき規則は AGENTS.md の不変条件と [invariants.md](invariants.md) にある。

## ディレクトリ一覧

| ディレクトリ | 役割 |
|---|---|
| `core/` | `AppContext`, `EventRecorder` (中央イベント記録) |
| `tracking/` | イベント検出器: `InputDetector`, `OperationDetector` (composition 系の inputType は `CompositionTracker` (Monaco アダプタ) + `compositionCorrelation.ts` (純関数) が実際の composition に範囲で対応付けた編集にだけ付ける。文字種では推定しない = #720。`EditorController` が change ごとに記録と同じ順で `attribute` を呼び、帰属を `detectOperationType` の第 3 引数で渡す), `KeystrokeTracker` (keyDown/keyUp。**合成打鍵は `data.isTrusted=false` を載せる** = ADR-0018。信頼打鍵は省略し hash 不変)、`MouseTracker`, `WindowTracker`, `VisibilityTracker`, `NetworkTracker`, `ScreenshotTracker`, `EnvironmentTracker` (起動時ワンショット `environmentProbe`。**editor-assist 宣言** = Monaco 解決済み支援オプションを `editorAssist` に焼く = ADR-0019。provider は main.ts が `recordInitial` 前に注入、正規化は `editorAssist.ts` の純関数) |
| `editor/` | `EditorController`, `CursorTracker`, `ThemeManager` |
| `execution/` | `CodeExecutionController`, `RuntimeManager` |
| `executors/` | 言語別実行: C, C++ (Wasmer SDK), JavaScript, TypeScript, Python (Pyodide)。TS は Monaco 同梱の TS worker で transpile (型チェックなし。#605)。Python は opaque origin の sandbox iframe の中の classic Worker (`python/PythonRunner.ts` / `pythonRunnerDocument.ts` / `pythonRunnerWorkerSource.ts`) で Pyodide を動かし、stdin は runner の SharedArrayBuffer の行チャネルで渡す (ADR-0047 / ADR-0056)。`sandbox/` = JS / TS を opaque origin の sandbox iframe 内の Blob Worker で動かす `SandboxRunner` と、その runner (srcdoc + CSP)・Worker のソース (文字列定数)・メッセージの検査・上限 (ADR-0041)。`nonInteractive/` = stdin を一括で渡して stdout を回収する非対話の実行の入口 (`runNonInteractive`。教員用の一括検証が使う。#802) |
| `ui/components/` | モーダル / 通知 / ドロップダウン / パネル |
| `export/` | `ProofExporter`, README テンプレート、救出 (`rescueBundle.ts` の純関数 `buildRescueBundle` と `RescueExporter`。証明ではない `RESCUE_TC<ts>.zip`。導線は設定メニューの `#rescue-download-btn` と問題パネルの `#problem-rescue-btn`。#544 / ADR-0042) |
| `services/` | `TurnstileService`, `StorageService`, `ScreenshotStorageService`, `SignedCheckpointService` |
| `terminal/` | `CTerminal` (xterm.js) |
| `i18n/` | 翻訳 (ja/en) と型定義 |
| `authoring/` | `/author` (作問)。`AuthorPage.ts` = 殻 (組み立て・書き出しのパネル・実行と検証の配線)。`distribution.ts` = 試験定義と問題列から配布物 (`.tcexam` / `.tcclass`) を作る入口 (生成器 `examPackageAuthoring.ts`・`classPackageAuthoring.ts` は変えない)。`ui/` = 画面の部品 (`WelcomeView`・`ExplorerView`・`EditorArea`・`ExamFormView`・`ExamPreviewView`・`CasesFormView`・`VerificationPanel`・`authorDialogs`・`issueList`、ファイルの種類ごとの表示の登録 `documentViews.ts`。DOM と Monaco はここと殻だけが触る) と、DOM に触れない小さな状態・純関数 (`editorLayout.ts` = 群とタブの配置、`partNames.ts` = 追加するファイルの既定の名前、`messages.ts` = 理由の文、`copyResult.ts` = コピーの結果の文、`fileKinds.ts`)。`workspace/` = 教材フォルダ (ADR-0051 / system-spec §4.10): 状態 `authorWorkspace.ts` (`AuthorWorkspace` = 索引・開いている文書・問題と試験の操作。DOM に触れず、ユニットテストの中心)、試験定義のフォームの操作 (`examForm.ts`) とケースファイルのフォームの操作 (`casesForm.ts`)、定義ファイル (問題・ケース・試験) の parse / 新規作成 / 書き戻し (`definitions.ts`)、参照パスの解決と逆向き (`paths.ts`)、教材 → `ExamBundleProblem[]` の変換と欠損検出 (`examBundle.ts`)、問題のコピー (`copyProblem.ts`。調べ終えてから書き、定義を最後に書く。#817) と、画面からのコピーの可否と実行 (`problemCopy.ts`。#800)、フォルダの読み書きと再開 (`materialFolder.ts`・`folderAccess.ts`・`folderHandleStore.ts`)。純関数はファイルを `WorkspaceReader` (`reader.ts`) の注入越しに読む。パスはすべて教材フォルダの根からの相対 POSIX パス (先頭に `/` を付けない)。`verification/` = 教員用の一括検証 (#802 / #799): 比較 (`compareOutput.ts`)、一括の実行器 (`runBatchVerification.ts`)、対象の収集 (`collectTargets.ts`)、結果表の状態と排他 (`verificationTable.ts` の `ExecutionLock`)、行ごとの差分 (`outputDiff.ts`)、E2E 用の偽の入口 (`fakeRunner.ts`。dev フックだけが使う) |

## データフロー

```
User Action
  → InputDetector (paste/drop 検出)
  → OperationDetector (Monaco 変更 → operation 種別)
  → KeystrokeTracker / MouseTracker / ...
  → EventRecorder (キューイング、fire-and-forget)
  → TypingProof.recordEvent() [shared]
  → HashChainManager → PoswManager (Web Worker)
  → StoredEvent → IndexedDB (イベント本体) + sessionStorage (タブ状態。proof データは localStorage に置かない)
  → (cp 作成時) SignedCheckpointService → Workers /api/checkpoint/sign
```

エクスポート:

```
ProofExporter.exportAllTabsAsZip() (#download-btn / 問題パネルの #download-log-btn。タブ 0 なら export.noTabs を通知して戻る)
  → performSelfReview() (ADR-0022。capabilities.selfReview、exam は off。1 回だけ・任意の reflectionNote をアクティブなタブのチェーンへ)
  → performPreExportVerificationForAllTabs() (Turnstile。全タブに記録。exam/class/assignment は best-effort)
  → タブごとに drainQueueOrAbort() → exportProof()
  → getProofData() → ScreenshotTracker.getAllScreenshots()
  → (授業・課題で問題を読み込んだタブだけ) 問題文を <base>_problem(_N).md として同梱 (#778。証明の対象外)
  → JSZip → ダウンロード (タブ 1 つなら <proofBaseName>_TC<ts>.zip、2 つ以上なら ALL_TC<ts>.zip)
  ── ここで export の区間 (isExporting) を閉じる ──
  → ZIP に入れた全タブの proof.json に verifyProofFile (fast) をかけて自己検証 → 結果の通知 (全部 valid なら export.zipSuccessVerified、1 つでも invalid / throw なら export.verifyFailed)
```

単一フライトのガード (`isExporting`) はダウンロードまでの区間だけを閉じる。ダウンロード後の自己検証 (`verifyAfterDownload`) は区間の外で走らせ、その間に押された次の export を無視しない (#565)。自己検証は ZIP に入れたのと同じ proof.json の文字列 (全タブ分) に shared の `verifyProofFile` を `{ mode: 'fast' }` (PoSW を再計算しない) でかけ、全部の `valid` で通知を選ぶ (#586。#779 で全タブ版へ移した)。通知の欄は 1 つで続けて出すと上書きされるので、ダウンロード直後には通知を出さず、検証後の 1 回にまとめる。受理ポリシー (`require*`) は立てないので、結論は同じ ZIP を verify-cli の既定で検証したときと一致する。記録中のメモリ (`TypingProof`) ではなく ZIP と同じスナップショットを検証するので、検証の途中に次の export が同じ proof へ記録しても関係ない (`export/__tests__/ProofExporter.verifyAfterDownload.test.ts`)。検証の throw は ZIP が出た後なので `export.zipFailed` ではなく `export.verifyFailed` で知らせる。

問題文の同梱 (#778) は `ProofExporter.setProblemStatementResolver` で main が注入し、授業・課題 (`capabilities.problemPanel && !sealedProblem`) でだけ `ClassProblemStore` を filename で引く。試験 (封印) と練習には注入しない (試験に入れないのは、復号した問題文が開けるファイルとして残り、使い回しで流出しやすくなるため)。問題文は proof にもチェーンにも入れない (ADR-0014)。名前は shared の `createExportNamer` の `problem` (proof と同じ番号)、検証側は `isSubmissionSourceEntry` がソースの候補から外す。問題を読み込んだ後に改名したタブは引けず、同梱されない (問題パネルの再表示と同じ制約)。
