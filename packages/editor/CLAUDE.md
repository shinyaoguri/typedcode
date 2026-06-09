# packages/editor — CLAUDE.md

`@typedcode/editor` は **キーストロークを記録して証明 ZIP を作る Monaco エディタアプリ**。

## 責務と境界

- **持つ**: Monaco との統合、イベント検出 (paste/drop/keyboard/mouse/focus/visibility)、PoSW 用 Web Worker のホスト、IndexedDB 永続化、ZIP エクスポート、Turnstile クライアント、署名済み cp の発行依頼
- **持たない**: 検証ロジック (verify 側) や暗号証明エンジン本体 (shared 側)。`TypingProof` のファサードを使うだけで、ハッシュ計算アルゴリズム自体には触らない

## 重要な不変条件

1. **Event #0 は `humanAttestation`**: ファイル作成時の Turnstile 認証をチェーンの根として固定する。**他のイベントを #0 にしてはいけない** (チェーン根の信頼性が崩れる)
2. **`EventRecorder` は fire-and-forget**: PoSW 待ちで UI をブロックしない。代わりに `queuedEventCount` を露出して UI が表示する
3. **`SignedCheckpointService` は単一フライト**: 並列 `flush()` を許すと同一 cp の二重署名で `previousSignedCheckpointHash` チェーンが破綻する ([docs/adr/0003-idempotent-signing-retry.md](../../docs/adr/0003-idempotent-signing-retry.md))
4. **`InputDetector` の paste 検出**: `SessionContentRegistry` と照合して `insertFromPaste` (禁止) と `insertFromInternalPaste` (許可) を分ける。この判定がピュアタイピング判定の入口
5. **IndexedDB の書き込みは逐次**: イベント記録順序が崩れると復元時のチェーンが壊れる
6. **エクスポート前 attestation**: `ProofExporter.export` は Turnstile 検証 (`performPreExportAttestation`) を **必ず** 通す。バイパスしない

## ディレクトリ一覧

| ディレクトリ | 役割 |
|---|---|
| `core/` | `AppContext`, `EventRecorder` (中央イベント記録) |
| `tracking/` | イベント検出器: `InputDetector`, `OperationDetector`, `KeystrokeTracker`, `MouseTracker`, `WindowTracker`, `VisibilityTracker`, `NetworkTracker`, `ScreenshotTracker` |
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
  → StoredEvent → localStorage + IndexedDB
  → (cp 作成時) SignedCheckpointService → Workers /api/checkpoint/sign
```

エクスポート:

```
ProofExporter.export()
  → performPreExportAttestation() (Turnstile)
  → getProofData() → ScreenshotTracker.getAllScreenshots()
  → JSZip → ダウンロード
```

## よくある罠

- **`vite-plugin-top-level-await` は rollup を要求**: Vite 8 は rolldown ベースだが、このプラグインが rollup を `require` する。`package.json` の `devDependencies` に `rollup` を明示しないとビルドが落ちる
- **Monaco の `onDidChangeModelContent` イベントは ICustomEvent ではない**: `InputDetector` で paste を判定するときの DOM event は `editor.onDidPaste` 経由で取る (Monaco の paste は contentChange と paste の 2 段)
- **IndexedDB のバージョンマイグレーション**: スキーマを変えるときは `STORAGE_FORMAT_VERSION` を bump し、`shared` のマイグレーション関数を更新する
- **ビルド時に注入される `__GIT_COMMIT__` 等**: dev サーバでは undefined になることがあるので、参照側でフォールバックを持つ
- **ルートはモード選択ランディング (ADR-0015)**: `/` と**未知パス**は `resolveRoute()` で `'landing'` になり、`LandingPage` がエディタ初期化 (`initializeApp`) を**短絡**して 4 モードの**比較カード**(料金比較ページ風、`.landing-card-mode[data-mode]`)だけ DOM 描画する(`main.ts` 末尾の `boot()` が分岐)。能力差(用途/問題配布/スクショ/封印/保証)を一覧化。カードクリックで `markTermsAccepted()` → `/<mode>` へ遷移。`/casual` は**明示ルート**化(タイポ `/exsm` は黙 casual せず入口へ=事故防止)。**アクセント色は要素スコープ** (`.landing-card-mode[data-mode]` の `--card-accent`) で付ける — `:root[data-mode]` は landing では casual 固定になり全列同色になるので使わない。**進行中セッションバッジ**は `core/SessionDetector.ts` が各モードのセッション IndexedDB を**バージョン指定なし read-only で開き**(非存在なら `onupgradeneeded` を abort=空 DB を作らない)tab 数を数え、`LandingPage.fillSessionBadges` が非同期で「続きから (N)」を出す。**モード切替**は `ui/components/ModeSwitcher.ts`(titlebar の現モードピル+ドロップダウン、旧静的 `feature-badge` を置換、`main.ts` の `if(!isLanding)` で生成)。別モード選択で `/<mode>` へ遷移、storage 名前空間が別なので現モード作業は保持。**通常モード (casual=「練習/Demo」) の摩擦低減**: 利用規約モーダルを出さない(`ctx.mode!=='casual' && !hasAcceptedTerms()` のときだけ表示。同意は入口で一度、`termsAccepted` イベントは後段で記録され provenance 維持)、画面共有は能力 `promptScreenShareAtStart=false` で**起動時に勧誘せず opt-out 状態で開始** + 「画面共有を有効にする」バナー(既存 `onResume`)からオプトイン。**Turnstile `#0` は維持**。casual の**内部 id・ルート `/casual`・storage・proof `mode` は不変**で表示名 `feature.casual` だけ変更。注意: top-level の `monaco.editor.create` (main.ts) は landing でも走る(Monaco mount は将来 lazy-split で回避)→ landing は `#app` を `display:none` にして不可視化。
- **試験モードはパスで入る (ADR-0011, ADR-0010 の sticky を置換)**: `/exam` で試験モード (`ctx.mode==='exam'`、派生 `ctx.examMode`)。**モードは `resolveModeFromPath` で URL パスから毎回確定**するので sticky フラグを持たない (旧 `?exam=1` + `localStorage['typedcode-exam-mode']` を置換)。リロードでもパスが残り試験モードを維持。別パス (`/`) へ移れば抜けられるが、整合性は封印の暗号束縛 (ADR-0006) が担保するので閉じ込め不要 (抜けても有効な試験 proof は作れない)。**ストレージはモード別に名前空間化** (`core/storageKeys.ts`: session IndexedDB 名・sessionStorage キー (`tabs`/`session-active`)・問題キャッシュを `-<mode>` 化、**casual は従来名**で移行不要)。`main.ts` 最初期に `setStorageNamespace(mode)` を 1 回呼び、各所はキー literal でなく storageKeys の getter を使う。これでモード間でセッションが**共存**し混ざらない (PR1/PR2 の auto-clear を置換。スクショは session DB の `screenshots` ストアなので自動で名前空間化される)。`ctx.examMode` が真の間は問題タブを 1 つ生成し、`TabManager.setExamLock(true)` で `createTab`/`closeTab` を源流ロック (add-tab/close ボタンは CSS で非表示)。提出は **Moodle で行うため TypedCode 側に「提出」操作は持たない**。ダウンロードは**問題パネルの「ログをダウンロード」ボタンに一本化** (`#download-log-btn` → `proofExporter.exportAllTabsAsZip()`、証明 + コードの ZIP) し、受験者がそれを Moodle に提出する。一本化のため**左の汎用 DL メニュー `#download-menu-btn` は exam モードで CSS 非表示**。問題パネルは右端ドラッグでリサイズ・× で閉じる・**左 Activity Bar** の `#toggle-problem-btn` で再表示 (VSCode 風。トグルは exam モードのみ表示)。`?reset` は手動の全消去として残置 (sticky 解除用でなくデータクリア用)。proof には生成時の `mode` を記録 (自己申告ラベル、ADR-0011)。モード体系 (casual/class/assignment/exam) と能力は `core/mode.ts`
- **試験モードの暗号コア解錠 (ADR-0006)**: 初回入場は `ExamStartGate` (全画面ブロック) で `.tcexam` 取込 + 監督コード → shared の `verifyExamPackageSignature`/`decryptExamPackage` → `TabManager.createTab({examContext})` が `TypingProof.initializeExam` で **genesis = 監督コード入力時にチェーン根を束縛** (`#0 humanAttestation` は best-effort、`#1 examOpened`)。問題本文は `ProblemPanel` 表示 + `ExamPackageStore` (localStorage) に保存しリロードで再表示。`examContext` は IndexedDB/sessionStorage の proof 状態 3 経路に透過。**export 前 Turnstile も exam では best-effort** (`ProofExporter.setPreExportBestEffort(true)` を `capabilities.preExportBestEffort` で駆動、Workers 不達でも ZIP を出す)。dev 出題者鍵は `shared/.../examAuthorityKeys/localKeys.ts` (skip-worktree)
- **授業モードの平文問題配布 (ADR-0014)**: `/class` は**封印しない** (問題は公開、tier ① 自己申告)。初回入場は `ClassProblemLoader` (**非ブロッキング**・監督コードなし・スキップ可) で平文 `.tcclass` (`{schema:'tcclass/1', classId, allowed, bundle}`、shared の `parseClassPackage` で**構造検証のみ・署名検証なし**) を取込 → `openClassTabs` が各問を **casual タブ** (`examContext` なし = **root 束縛なし**) で N タブ展開。starter は既存の `recordTemplateInjection` で注入し `templateName='tcclass/${classId}/${problemId}'` が **self-asserted problemId** を proof に残す (新イベント型/proof フィールドを足さない = `PROOF_FORMAT_VERSION` 据え置き・完全後方互換)。問題本文は `ProblemPanel` + `ClassProblemStore` (**filename キー**。class タブは examContext を持たず problemId を proof から引けないため、タブ切替/リロードの照合は filename で行う)。能力は `capabilities.problemPanel`/`fullscreenTracking`/`fullscreenBanner` (受動記録なので false) で駆動。`body.has-problem-panel` クラスが問題パネルのトグルボタン表示を制御 (exam/class 共通。`body.exam-mode` は exam 固有のクロムだけに残す)。`/author` は同じ問題から `buildClassPackage` で未封印 `.tcclass` も出せる (examId を classId に流用)。**Turnstile storm 回避**は exam と同じ `sharedAttestation` (先頭タブ #0 を共有)

## i18n

- `src/i18n/translations/{ja,en}.ts` に翻訳を追加
- `src/i18n/types.ts` の `EditorTranslationKeys` に **必ず** 同じキーを追加 (型エラーで漏れを検出)
- ロケール検出: localStorage → ブラウザ言語 → `ja`
