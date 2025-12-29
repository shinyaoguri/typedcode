# @typedcode/editor

TypedCode メインエディタ - Monaco Editor ベースの逐次タイピング証明エディタ

## 概要

Monaco Editor（VSCode のエディタエンジン）をベースにした、全ての入力操作を暗号学的に記録するエディタです。マルチタブ、ブラウザ内コード実行、リアルタイム操作ログを提供します。

## 機能

### エディタ機能

- **マルチタブ**: 複数ファイルの同時編集、タブごとに独立した証明チェーン
- **言語サポート**: C, C++, Python, JavaScript, TypeScript
- **テーマ**: ライト/ダークモード切り替え
- **Monaco Editor**: シンタックスハイライト、自動補完、エラー表示

### イベント追跡

- **テキスト操作**: 文字入力、削除、IME入力、Undo/Redo
- **カーソル/選択**: 位置変更、選択範囲
- **外部入力検出**: ペースト、ドラッグ&ドロップ
- **環境イベント**: ウィンドウリサイズ、可視性変更、フォーカス

### コード実行

ブラウザ内でコードを実行（サーバー不要）:

| 言語 | 実行環境 | 備考 |
|-----|---------|------|
| C | Wasmer SDK + Clang | WASM コンパイル |
| C++ | Wasmer SDK + Clang++ | C++17 サポート |
| Python | Pyodide | CPython 3.11 |
| JavaScript | ネイティブ | eval 実行 |
| TypeScript | SWC → eval | 即時トランスパイル |

### 証明機能

- **PoSW**: Proof of Sequential Work（10,000回逐次ハッシュ）
- **チェックポイント**: 100イベントごとに検証ポイント作成
- **エクスポート**: JSON（単一）またはZIP（複数ファイル）
- **人間認証**: Turnstile 統合（オプション）

## 開発

```bash
# 開発サーバー起動（http://localhost:5173）
npm run dev

# ビルド
npm run build

# プレビュー
npm run preview
```

## アーキテクチャ

### ディレクトリ構成

```
src/
├── main.ts                 # エントリーポイント
├── core/
│   ├── EventRecorder.ts    # 中央イベントディスパッチャー
│   └── RuntimeManager.ts   # 言語ランタイム状態管理
├── editor/
│   ├── EditorController.ts # Monaco 変更追跡
│   ├── CursorTracker.ts    # カーソル/選択イベント
│   └── ThemeManager.ts     # テーマ切り替え
├── tracking/
│   ├── OperationDetector.ts   # 操作種別判定
│   ├── InputDetector.ts       # ペースト/ドロップ検出
│   ├── KeystrokeTracker.ts    # キーボードイベント
│   ├── MouseTracker.ts        # マウス位置追跡
│   ├── WindowTracker.ts       # ウィンドウイベント
│   └── VisibilityTracker.ts   # タブ可視性
├── executors/
│   ├── interfaces/
│   │   └── ILanguageExecutor.ts
│   ├── base/
│   │   └── BaseExecutor.ts
│   ├── c/CExecutor.ts
│   ├── cpp/CppExecutor.ts
│   ├── python/PythonExecutor.ts
│   ├── javascript/JavaScriptExecutor.ts
│   └── typescript/TypeScriptExecutor.ts
├── execution/
│   └── CodeExecutionController.ts
├── terminal/
│   └── CTerminal.ts        # xterm.js ラッパー
├── ui/
│   ├── components/
│   │   ├── LogViewer.ts    # 操作ログ表示
│   │   ├── Modal.ts        # ダイアログ
│   │   ├── ProofStatusDisplay.ts
│   │   └── SettingsDropdown.ts
│   ├── tabs/
│   │   ├── TabManager.ts   # タブ状態管理
│   │   └── TabUIController.ts
│   └── panels/
│       ├── TerminalPanel.ts
│       └── LogViewerPanel.ts
├── export/
│   └── ProofExporter.ts    # 証明エクスポート
└── services/
    ├── TurnstileService.ts
    ├── StorageService.ts
    └── DownloadService.ts
```

### データフロー

```
ユーザー入力
    ↓
Tracker (Keystroke/Mouse/Window/...)
    ↓
EventRecorder
    ↓
TabManager → TypingProof.recordEvent()
    ↓
PoSW 計算 (Web Worker)
    ↓
ハッシュ鎖更新 + localStorage 保存
    ↓
LogViewer + ProofStatusDisplay 更新
```

### コード実行フロー

```
Run ボタン
    ↓
CodeExecutionController
    ↓
ExecutorRegistry.get(language)
    ↓
LanguageExecutor.run(code, terminal)
    ↓
WASM/Pyodide/eval 実行
    ↓
出力を CTerminal に表示
```

## 主要コンポーネント

### EventRecorder

全てのトラッカーからイベントを受け取り、アクティブタブの TypingProof に記録。

```typescript
eventRecorder.record({
  type: 'contentChange',
  inputType: 'insertText',
  data: 'a',
  description: '文字入力',
});
```

### TabManager

マルチタブの状態管理。各タブは独立した TypingProof インスタンスを持つ。

```typescript
tabManager.createTab('main.c', 'c');
tabManager.switchTab(tabId);
const proof = tabManager.getActiveProof();
```

### ExecutorRegistry

言語ごとのエグゼキュータを管理。プラグイン形式で拡張可能。

```typescript
const executor = ExecutorRegistry.get('python');
await executor.init();
await executor.run(code, terminal, { onOutput, onError });
```

### ProofExporter

証明データのエクスポート。検証を行ってからダウンロード。

```typescript
const exporter = new ProofExporter();
await exporter.exportSingle(tabManager, 'main.c');
await exporter.exportAll(tabManager); // ZIP
```

## 設定

### Vite 設定

```typescript
// vite.config.ts
export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  esbuild: {
    drop: ['console', 'debugger'], // 本番ビルド時
  },
});
```

### 環境変数

| 変数 | 説明 |
|-----|------|
| `VITE_TURNSTILE_SITE_KEY` | Turnstile サイトキー（オプション） |
| `VITE_API_URL` | Workers API エンドポイント |

## localStorage キー

| キー | 内容 |
|-----|------|
| `typedcode-device-id` | 永続デバイスID |
| `typedcode-tabs-*` | タブ状態（コンテンツ + 証明） |
| `typedcode-terms-accepted` | 利用規約同意バージョン |

## 依存関係

### 主要ライブラリ

- **monaco-editor**: ^0.55.1 - エディタエンジン
- **@xterm/xterm**: ^6.0.0 - ターミナルエミュレータ
- **@wasmer/sdk**: WASM ランタイム
- **jszip**: ^3.10.1 - ZIP エクスポート

### ビルドツール

- **vite**: ^7.3.0
- **typescript**: ^5.9.3
- **vite-plugin-wasm**: WASM サポート
- **vite-plugin-top-level-await**: Top-level await サポート
