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
- **試験モードはパスで入る (ADR-0011, ADR-0010 の sticky を置換)**: `/exam` で試験モード (`ctx.mode==='exam'`、派生 `ctx.examMode`)。**モードは `resolveModeFromPath` で URL パスから毎回確定**するので sticky フラグを持たない (旧 `?exam=1` + `localStorage['typedcode-exam-mode']` を置換)。リロードでもパスが残り試験モードを維持。別パス (`/`) へ移れば抜けられるが、整合性は封印の暗号束縛 (ADR-0006) が担保するので閉じ込め不要 (抜けても有効な試験 proof は作れない)。**モード切替時は前モードのセッションを auto-clear** (`typedcode-last-mode` 比較。PR1 はストレージ共有、per-mode 名前空間化は後続 PR)。`ctx.examMode` が真の間は問題タブを 1 つ生成し、`TabManager.setExamLock(true)` で `createTab`/`closeTab` を源流ロック (add-tab/close ボタンは CSS で非表示)。提出は **Moodle で行うため TypedCode 側に「提出」操作は持たない**。ダウンロードは**問題パネルの「ログをダウンロード」ボタンに一本化** (`#download-log-btn` → `proofExporter.exportAllTabsAsZip()`、証明 + コードの ZIP) し、受験者がそれを Moodle に提出する。一本化のため**左の汎用 DL メニュー `#download-menu-btn` は exam モードで CSS 非表示**。問題パネルは右端ドラッグでリサイズ・× で閉じる・**左 Activity Bar** の `#toggle-problem-btn` で再表示 (VSCode 風。トグルは exam モードのみ表示)。`?reset` は手動の全消去として残置 (sticky 解除用でなくデータクリア用)。proof には生成時の `mode` を記録 (自己申告ラベル、ADR-0011)。モード体系 (casual/class/assignment/exam) と能力は `core/mode.ts`
- **試験モードの暗号コア解錠 (ADR-0006)**: 初回入場は `ExamStartGate` (全画面ブロック) で `.tcexam` 取込 + 監督コード → shared の `verifyExamPackageSignature`/`decryptExamPackage` → `TabManager.createTab({examContext})` が `TypingProof.initializeExam` で **genesis = 監督コード入力時にチェーン根を束縛** (`#0 humanAttestation` は best-effort、`#1 examOpened`)。問題本文は `ProblemPanel` 表示 + `ExamPackageStore` (localStorage) に保存しリロードで再表示。`examContext` は IndexedDB/sessionStorage の proof 状態 3 経路に透過。**export 前 Turnstile も exam では best-effort** (`ProofExporter.setExamMode(true)`、Workers 不達でも ZIP を出す)。dev 出題者鍵は `shared/.../examAuthorityKeys/localKeys.ts` (skip-worktree)

## i18n

- `src/i18n/translations/{ja,en}.ts` に翻訳を追加
- `src/i18n/types.ts` の `EditorTranslationKeys` に **必ず** 同じキーを追加 (型エラーで漏れを検出)
- ロケール検出: localStorage → ブラウザ言語 → `ja`
