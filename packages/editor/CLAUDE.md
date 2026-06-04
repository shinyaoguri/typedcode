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

## i18n

- `src/i18n/translations/{ja,en}.ts` に翻訳を追加
- `src/i18n/types.ts` の `EditorTranslationKeys` に **必ず** 同じキーを追加 (型エラーで漏れを検出)
- ロケール検出: localStorage → ブラウザ言語 → `ja`
