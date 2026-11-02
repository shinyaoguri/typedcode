# packages/editor — AGENTS.md

`@typedcode/editor` は **キーストロークを記録して証明 ZIP を作る Monaco エディタアプリ**。

## 責務と境界

- **持つ**: Monaco との統合、イベント検出 (paste/drop/keyboard/mouse/focus/visibility)、PoSW 用 Web Worker のホスト、IndexedDB 永続化、ZIP エクスポート、Turnstile クライアント、署名済み cp の発行依頼
- **持たない**: 検証ロジック (verify 側) や暗号証明エンジン本体 (shared 側)。`TypingProof` のファサードを使うだけで、ハッシュ計算アルゴリズム自体には触らない

## 重要な不変条件

1. **Event #0 は `humanAttestation`**: ファイル作成時の Turnstile 認証をチェーンの根として固定する。**他のイベントを #0 にしてはいけない** (チェーン根の信頼性が崩れる)。**ADR-0017**: casual/class では Turnstile を `/api/session/start` に統合し、**initialize より先に**実行して `serverNonce` 入り ECDSA トークンを得て `TypingProof.initializeAnchored` で root をサーバアンカーする (`SHA256(fp ‖ localNonce ‖ serverNonce)`)。`#0 humanAttestation` は引き続き記録するが暗号的束縛は proof 同梱の `sessionStartToken` が担う。session/start の `sessionId` は **`sessionService.getCurrentSessionId()`** (署名 cp と同じ) を使う (verifier が token↔cp の sessionId 一致を要求)。不達時は従来 `initialize` にフォールバック (`rootAnchored:false`、開始はブロックしない)。`createTabFromTemplate` のバンドルタブは現状非アンカー (follow-up)
2. **`EventRecorder` は fire-and-forget**: PoSW 待ちで UI をブロックしない。代わりに `queuedEventCount` を露出して UI が表示する
3. **`SignedCheckpointService` は単一フライト**: 並列 `flush()` を許すと同一 cp の二重署名で `previousSignedCheckpointHash` チェーンが破綻する ([docs/adr/0003-idempotent-signing-retry.md](../../docs/adr/0003-idempotent-signing-retry.md))。**署名は `sessionStartToken` 前提** (ADR-0027): token はセッション単位で `TabManager.findSigningToken` が解決 (casual/class/assignment は root アンカー時の token を流用、exam は `acquireSigningTokenBestEffort` が非ブロッキングで署名専用 token を取得し root には焼かない)。token が無い間は送信せず待機し、`TOKEN_INVALID`/`TOKEN_SESSION_MISMATCH` は恒久失敗として queue を空にする。**sign の fetch は `WORKERS_FETCH_TIMEOUT_MS` で打ち切り**、タイムアウトは通常の失敗 (backoff 再試行) として `flushing` を解除する (恒久失敗にしない。#324)
4. **`InputDetector` の paste 検出**: `SessionContentRegistry` と照合して `insertFromPaste` (禁止) と `insertFromInternalPaste` (許可) を分ける。この判定がピュアタイピング判定の入口
5. **IndexedDB の書き込みは逐次**: イベント記録順序が崩れると復元時のチェーンが壊れる
6. **エクスポート前 attestation**: `ProofExporter` の export (`exportCurrentTab` / `exportAllTabsAsZip`) は Turnstile 検証 (`performPreExportVerification` / `…ForAllTabs`) を通す。ただし **exam/class/assignment は `preExportBestEffort=true`** (capabilities) で、Turnstile 不達/失敗でも失敗 attestation を記録して提出 ZIP を出す (ADR-0006/0011。教室の不安定網で受験者を締め出さない)。casual は従来どおりブロックする。best-effort の認証全体は `PRE_EXPORT_VERIFICATION_BUDGET_MS` で打ち切り、超過は失敗 attestation 経路に回す (casual は無期限に待つ。#324)

## ディレクトリ一覧

| ディレクトリ | 役割 |
|---|---|
| `core/` | `AppContext`, `EventRecorder` (中央イベント記録) |
| `tracking/` | イベント検出器: `InputDetector`, `OperationDetector`, `KeystrokeTracker` (keyDown/keyUp。**合成打鍵は `data.isTrusted=false` を載せる** = ADR-0018。信頼打鍵は省略し hash 不変)、`MouseTracker`, `WindowTracker`, `VisibilityTracker`, `NetworkTracker`, `ScreenshotTracker`, `EnvironmentTracker` (起動時ワンショット `environmentProbe`。**editor-assist 宣言** = Monaco 解決済み支援オプションを `editorAssist` に焼く = ADR-0019。provider は main.ts が `recordInitial` 前に注入、正規化は `editorAssist.ts` の純関数) |
| `editor/` | `EditorController`, `CursorTracker`, `ThemeManager` |
| `execution/` | `CodeExecutionController`, `RuntimeManager` |
| `executors/` | 言語別実行: C, C++, JavaScript, TypeScript, Python (Wasmer SDK) |
| `ui/components/` | モーダル / 通知 / ドロップダウン / パネル |
| `export/` | `ProofExporter`, README テンプレート |
| `services/` | `TurnstileService`, `StorageService`, `ScreenshotStorageService`, `SignedCheckpointService` |
| `terminal/` | `CTerminal` (xterm.js) |
| `i18n/` | 翻訳 (ja/en) と型定義 |

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
ProofExporter.export()
  → performSelfReview() (ADR-0022。capabilities.selfReview、exam は off。任意の reflectionNote をチェーンへ)
  → performPreExportVerification() (Turnstile。exam/class/assignment は best-effort)
  → getProofData() → ScreenshotTracker.getAllScreenshots()
  → JSZip → ダウンロード
```

## 状態契約 (data-* 属性)

E2E (`packages/e2e`) は editor の UI 状態を、翻訳テキストや CSS クラスではなくここに挙げる **data-\* 属性** と dev 限定フック `__tcTestSnapshot` で読む ([ADR-0034](../../docs/adr/0034-replace-manual-verification-with-automated-tests.md)、#433)。値は生の値 (id・言語 id・enum) で、翻訳しない。既存の class (`active` / `synced` など) や表示テキストはそのまま残してあり、契約はそれに**足した**もの。

| 要素 | 属性 | 取りうる値 | 意味 |
|---|---|---|---|
| `html` | `data-app-state` | `initializing` / `landing` / `gate` / `ready` | アプリの段階 (`core/stateContract.ts`)。`landing` = モード選択の入口、`gate` = 試験のスタートゲート (`ExamStartGate`) で解錠待ち、`ready` = 編集できる (タブ 0 本のウェルカム画面を含む)。利用規約・画面共有の選択・復旧ダイアログの間は `initializing`。起動を途中で止める画面 (別タブで起動中・未対応ブラウザ・認証失敗) でも `initializing` のまま残るので、何で止まったかは `data-dialog` で見る |
| `#editor-tabs .editor-tab` | `data-tab-id` | タブ id | どのタブか (契約以前からある属性) |
| 〃 | `data-active` | `true` / `false` (全タブに付ける) | アクティブなタブ。タブがあれば `true` はちょうど 1 つ |
| 〃 | `data-filename` | 拡張子込みの名前 (`Untitled-1.c`) | タブに表示される名前 (`tabFullFilename`)。改名の確定 (`startFilenameEdit` の finishEdit) でも更新する |
| 〃 | `data-language` | Monaco の言語 id (`c` / `python` …) | タブの言語 |
| 〃 | `data-verification` | `pending` / `verified` / `failed` / `skipped` | タブの `verificationState` (shared `VerificationState`) をそのまま出す。`.tab-verification` のインジケータが出るのは `verified` / `failed` だけだが、契約は 4 値とも出す |
| `#sync-status-item` | `data-state` | `synced` / `syncing` / `pending` | IndexedDB 同期状態 (`SyncStatus`。class と同じ値)。最初の状態通知までは属性なし |
| `#event-count` | `data-count` | 整数 | アクティブなタブの `totalEvents`。タブ 0 本 (reset) では `0` |
| `#current-hash` | `data-hash` | 省略しない完全なハッシュ / 空文字 | アクティブなタブの `currentHash` (表示は先頭 16 文字に省略)。タブ 0 本 (reset) では空 |
| ダイアログ・オーバーレイの root | `data-dialog` | 下記の名前 | どのダイアログか。**開いている = DOM にあって `.hidden` が付いていない** |

`data-dialog` の名前: `terms` / `reset` / `tab-close` / `processing` / `duplicate-instance` / `unsupported-browser` (以上 `index.html` の静的要素) / `session-recovery` / `welcome` (`.welcome-screen`) / `self-review` / `screen-share-choice` / `screen-share-optout-confirm` / `screen-share-error` / `screen-capture-lock` / `idle-warning` / `idle-suspended` / `export-progress` / `exam-gate`。`Modal.ts` の `showModal` / `showCountdownDialog` / `showLockOverlay` で作るものは引数 `dialogName` で overlay に付ける (新しいダイアログを足すときも名前を付ける)。

- **dev フック `window.__tcTestSnapshot()`** (`main.ts` の `import.meta.env.DEV` ガード内。`__tcTestInsertBlock` と同じ流儀): `{ appState, activeTabId, tabs: [{ id, filename, language, content, totalEvents, pendingCount, currentHash }] }` を返す (`core/stateContract.ts` の `buildTestSnapshot`)。tabs は表示順 (`getAllTabs()`)、filename は `data-filename` と同じ拡張子込み、タブ 0 本なら `activeTabId: null`。本番ビルドには残らない (`production-build.spec.ts` が見張る)
- E2E 側の読み手は [`packages/e2e/tests/helpers/app.ts`](../e2e/tests/helpers/app.ts) の `EditorApp` (`tabs()` / `openDialogs()` / `snapshot()` / `expectConsistent()`)。`expectConsistent()` は DOM の契約と snapshot の一致 (タブの順序・id・active・filename・language、アクティブなタブの件数・ハッシュ、`#language-selector` の値) を、PoSW の pending が 0 になって DOM が追いつくまで待って確かめる。**proof に記録したのに表示を更新しない経路を作ると、ここで食い違いとして落ちる** (export が EventRecorder を通さず記録する分は `ExportCallbacks.onProofChanged` で表示を追従させている)
- **この契約 (要素・属性名・値域・「無い」の意味・snapshot の形) を変えるときは、`packages/e2e` の E2E と同じ PR で変える**。片方だけ変えると E2E が赤になるか、もっと悪いと別の要素を読んで黙って通る。ユニットテストは `ui/tabs/__tests__/TabUIController.stateContract.test.ts` / `ui/components/__tests__/ProofStatusDisplay.test.ts` / `ui/components/__tests__/Modal.test.ts` (dialog state contract) / `core/__tests__/stateContract.test.ts`

## よくある罠

- **`vite-plugin-top-level-await` を再導入しない (#255)**: このプラグインはチャンクの全エクスポートを先頭の `let` に巻き上げて本体を async IIFE で包む。`export function` が代入文に降格するため、**関数宣言の巻き上げに依存している monaco** (`vs/platform/instantiation`: `createDecorator` を定義より前に呼ぶ) が壊れ、`createDecorator is not a function` → 以降のエクスポート代入が全て飛び `Class extends value undefined` に至る。**dev サーバでは再現せず本番ビルドだけが壊れる**ので、`packages/e2e/tests/production-build.spec.ts` (vite preview 対象) が番人。`build.target` を `esnext` から下げるときだけ再検討の余地がある
- **HTML プレビュー iframe は opaque origin (#291/#299)**: `#preview-iframe` は `sandbox="allow-scripts allow-modals allow-forms"` の 3 トークンだけを持つ。**`allow-same-origin` を足さない** (`allow-scripts` と併用すると同一 origin の学習者 HTML が親 DOM・localStorage・proof の IndexedDB に届き、sandbox 自体も外せる)。`allow-top-navigation*` / `allow-popups` / `allow-downloads` も付けない = トップレベル遷移・ポップアップ・ダウンロードは不可。親の `crossOriginIsolated` (COOP/COEP `credentialless`) はこのままで維持される。内容の投入は **`srcdoc` に一本化** (Blob URL / `src` と混在させると残った srcdoc が優先され再表示が空になる = #299。placeholder は `removeAttribute('srcdoc')` + `about:blank`)。親から `contentWindow` の中身 (scrollX 等) には触れないので、親子通信は **postMessage + 受信側で `e.source` を検査** (opaque origin なので `e.origin` は `'null'`)。スクロール保存/復帰は `BrowserPreviewPanel` が末尾に注入するブリッジ script 経由。回帰は `packages/e2e/tests/browser-preview.spec.ts`
- **ダイアログは `ui/components/dialogA11y.ts` の `attachDialogA11y` を使う (#305)**: `role` / `aria-modal` / `aria-labelledby`・初期フォーカス・Tab トラップ・Escape・起点へのフォーカス復帰を担う。document の keydown リスナーは `close()` でしか解放されないので、**閉じる経路 (ボタン・overlay・Escape) を 1 つの冪等な close 関数に集約して、その中で呼ぶ** (経路ごとに外すと取りこぼし、開閉のたびに古い Escape ハンドラが溜まる)。メニュー項目から開いてメニューが閉じる場合は `returnFocusTo` にメニューを開いたボタンを渡す (消えかけの項目は `focus()` が一度成功したあと body に落ちる)。ネイティブ `<dialog>` は top layer に出て `ExamStartGate` (z-index 40000) との重なりが変わるので使わない。`showModal()` は `closeOnOverlayClick: false` なら Escape でも閉じない。未移行のダイアログは `docs/accessibility-accommodation-policy.md` の移行状況を見る
- **起動時ワンショットは「セッションのスナップショット型」に登録する (#405)**: `recordToAllTabs` は記録した時点にあるタブにしか載せないので、起動時に 1 回だけ記録するイベントは、起動時にタブが無い class / assignment と 2 個目以降のタブの proof から欠落する。`EventRecorder` の `SESSION_SNAPSHOT_EVENT_TYPES` (`windowResize`・`networkStatusChange`・`environmentProbe`・`screenShareOptOut`) に入っている型は最新の 1 件を保持し、`TabManager.setOnTabCreated` (Phase 4.9 で配線) 経由で新しいタブに `recordSessionSnapshotTo` が流し直す (`termsAccepted` は main の `buildTermsAcceptedEvent` から作り、既にあるタブには重ねない。`screenShareOptOut` は `screenShareStart` が来たら保持を消す = 共有開始後のタブに opt-out を載せない)。**新しい起動時ワンショットを足すときはこの配列に登録する**。フックは `createTab` / `createTabFromTemplate` の `tabs.set` と**同じ同期区間**で呼ぶ (await を挟むと `recordToAllTabs` と二重・漏れになる)。Phase 4.9 より前に作られたタブ (casual の既定タブ・exam の開封タブ・復元タブ) と復元経路は対象外で、従来どおり Phase 5 / 5.5 で載る。状態が遷移するイベント (visibility / focus / fullscreen) は流し直さない (新しいタブは遷移に立ち会っていない)
- **Monaco の `onDidChangeModelContent` イベントは ICustomEvent ではない**: `InputDetector` で paste を判定するときの DOM event は `editor.onDidPaste` 経由で取る (Monaco の paste は contentChange と paste の 2 段)
- **IndexedDB のバージョンマイグレーション**: スキーマを変えるときは `STORAGE_FORMAT_VERSION` を bump し、`shared` のマイグレーション関数を更新する
- **ビルド時に注入される `__GIT_COMMIT__` 等**: dev サーバでは undefined になることがあるので、参照側でフォールバックを持つ
- **ルートはモード選択ランディング (ADR-0015)**: `/` と**未知パス**は `resolveRoute()` で `'landing'` になり、`LandingPage` がエディタ初期化 (`initializeApp`) を**短絡**して 4 モードの**比較カード**(料金比較ページ風、`.landing-card-mode[data-mode]`)だけ DOM 描画する(`main.ts` 末尾の `boot()` が分岐)。能力差(用途/問題配布/スクショ/封印/保証)を一覧化。カードクリックで `markTermsAccepted()` → `/<mode>` へ遷移。`/casual` は**明示ルート**化(タイポ `/exsm` は黙 casual せず入口へ=事故防止)。**アクセント色は要素スコープ** (`.landing-card-mode[data-mode]` の `--card-accent`) で付ける — `:root[data-mode]` は landing では casual 固定になり全列同色になるので使わない。**進行中セッションバッジ**は `core/SessionDetector.ts` が各モードのセッション IndexedDB を**バージョン指定なし read-only で開き**(非存在なら `onupgradeneeded` を abort=空 DB を作らない)tab 数を数え、`LandingPage.fillSessionBadges` が非同期で「続きから (N)」を出す。**モード切替**は `ui/components/ModeSwitcher.ts`(titlebar の現モードピル+ドロップダウン、旧静的 `feature-badge` を置換、`main.ts` の `if(!isLanding)` で生成)。別モード選択で `/<mode>` へ遷移、storage 名前空間が別なので現モード作業は保持。**通常モード (casual=「練習/Demo」) の摩擦低減**: 利用規約モーダルを出さない(`ctx.mode!=='casual' && !hasAcceptedTerms()` のときだけ表示。同意は入口で一度、`termsAccepted` イベントは後段で記録され provenance 維持)、画面共有は能力 `promptScreenShareAtStart=false` で**起動時に勧誘せず opt-out 状態で開始** + 「画面共有を有効にする」バナー(既存 `onResume`)からオプトイン。**Turnstile `#0` は維持**。casual の**内部 id・ルート `/casual`・storage・proof `mode` は不変**で表示名 `feature.casual` だけ変更。注意: top-level の `monaco.editor.create` (main.ts) は landing でも走る(Monaco mount は将来 lazy-split で回避)→ landing は `#app` を `display:none` にして不可視化。
- **試験モードはパスで入る (ADR-0011, ADR-0010 の sticky を置換)**: `/exam` で試験モード (`ctx.mode==='exam'`、派生 `ctx.examMode`)。**モードは `resolveModeFromPath` で URL パスから毎回確定**するので sticky フラグを持たない (旧 `?exam=1` + `localStorage['typedcode-exam-mode']` を置換)。リロードでもパスが残り試験モードを維持。別パス (`/`) へ移れば抜けられるが、整合性は封印の暗号束縛 (ADR-0006) が担保するので閉じ込め不要 (抜けても有効な試験 proof は作れない)。**ストレージはモード別に名前空間化** (`core/storageKeys.ts`: session IndexedDB 名・sessionStorage キー (`tabs`/`session-active`)・問題キャッシュを `-<mode>` 化、**casual は従来名**で移行不要)。`main.ts` 最初期に `setStorageNamespace(mode)` を 1 回呼び、各所はキー literal でなく storageKeys の getter を使う。これでモード間でセッションが**共存**し混ざらない (PR1/PR2 の auto-clear を置換。スクショは session DB の `screenshots` ストアなので自動で名前空間化される)。`ctx.examMode` が真の間は問題タブを 1 つ生成し、`TabManager.setExamLock(true)` で `createTab`/`closeTab` を源流ロック (add-tab/close ボタンは CSS で非表示)。提出は **Moodle で行うため TypedCode 側に「提出」操作は持たない**。ダウンロードは**問題パネルの「ログをダウンロード」ボタンに一本化** (`#download-log-btn` → `proofExporter.exportAllTabsAsZip()`、証明 + コードの ZIP) し、受験者がそれを Moodle に提出する。一本化のため**左の汎用 DL メニュー `#download-menu-btn` は exam モードで CSS 非表示**。問題パネルは右端ドラッグでリサイズ・× で閉じる・**左 Activity Bar** の `#toggle-problem-btn` で再表示 (VSCode 風。トグルは exam モードのみ表示)。`?reset` は手動の全消去として残置 (sticky 解除用でなくデータクリア用)。proof には生成時の `mode` を記録 (自己申告ラベル、ADR-0011)。モード体系 (casual/class/assignment/exam) と能力は `core/mode.ts`
- **試験モードの暗号コア解錠 (ADR-0006)**: 初回入場は `ExamStartGate` (全画面ブロック) で `.tcexam` 取込 + 監督コード → shared の `verifyExamPackageSignature`/`decryptExamPackage` → `TabManager.createTab({examContext})` が `TypingProof.initializeExam` で **genesis = 監督コード入力時にチェーン根を束縛** (`#0 humanAttestation` は best-effort、`#1 examOpened`)。問題本文は `ProblemPanel` 表示 + `ExamPackageStore` (localStorage) に保存しリロードで再表示。`examContext` は IndexedDB/sessionStorage の proof 状態 3 経路に透過。**export 前 Turnstile も exam では best-effort** (`ProofExporter.setPreExportBestEffort(true)` を `capabilities.preExportBestEffort` で駆動、Workers 不達でも ZIP を出す)。dev 出題者鍵は `shared/.../examAuthorityKeys/localKeys.ts` (skip-worktree)
- **授業/課題モードの平文問題配布 (ADR-0014/0015)**: `/class`・`/assignment` は**封印しない** (問題は公開、tier ① 自己申告)。**問題は左 Activity Bar の「問題を読み込む」(`#load-problem-btn` → `runClassLoad`) でいつでも取り込める** — 起動時に強制ローダは出さない (ADR-0015)。`ClassProblemLoader` (**非ブロッキング**・監督コードなし・スキップ可) で平文 `.tcclass` (`{schema:'tcclass/1', classId, allowed, bundle}`、shared の `parseClassPackage` で**構造検証のみ・署名検証なし**) を取込 → `openClassTabs` が各問を **casual タブ** (`examContext` なし = **root 束縛なし**) で N タブ展開。starter は既存の `recordTemplateInjection` で注入し `templateName='tcclass/${classId}/${problemId}'` が **self-asserted problemId** を proof に残す (新イベント型/proof フィールドを足さない = `PROOF_FORMAT_VERSION` 据え置き・完全後方互換)。問題本文は `ProblemPanel` + `ClassProblemStore` (**filename キー**。class タブは examContext を持たず problemId を proof から引けないため、タブ切替/リロードの照合は filename で行う)。**問題パネルは問題が読み込まれるまで開かない** (ADR-0015。未読込なのに exam の「試験モード」見た目で出る不具合を解消) — `main.ts` の panel 初期化は `setTitle(t('feature.<mode>'))`(試験/授業/課題)だけ行い `show()` しない。表示は load/restore パスが行う。能力は `capabilities.problemPanel` (exam/class/assignment=true)・`!sealedProblem` で「問題を読み込む」可否を判別 (`body.can-load-problem`)。`body.has-problem-panel` がトグルボタン表示を制御 (`body.exam-mode` は exam 固有クロムだけに残す)。`/author` は同じ問題から `buildClassPackage` で未封印 `.tcclass` も出せる (examId を classId に流用)。**Turnstile storm 回避**は exam と同じ `sharedAttestation` (先頭タブ #0 を共有)
- **入場時の初期状態 (ADR-0015)**: 練習 (casual) は**ウェルカム画面を出さず既定タブ `Untitled-1` を 1 つ自動生成**して即編集 (`main.ts` の entry で `mode==='casual' && !hasAnyTabs` のとき `createTab`)。授業/課題はウェルカム + 「問題を読み込む」で、読み込むと `runClassLoad` が `hideWelcomeScreen` + `openClassTabs` + キャプチャ再有効化/LogViewer 初期化を行う。exam だけ `ExamStartGate` で封印ゲート (下記)。

## i18n

- `src/i18n/translations/{ja,en}.ts` に翻訳を追加
- `src/i18n/types.ts` の `TranslationKeys` に **必ず** 同じキーを追加 (宣言済みセクション内のキーは型エラーで漏れを検出。ただし index signature があるため**新規トップレベルセクション**の追加漏れは型では拾えない点に注意)
- ロケール検出: localStorage → ブラウザ言語 → `ja`
