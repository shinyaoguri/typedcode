# TypedCode

逐次タイピング証明エディタ - 全ての入力操作をハッシュ鎖として記録し、改ざん不可能な証明を生成

## 概要

TypedCodeは、**全ての入力が逐次タイピングされたことを暗号学的に証明する**エディタです。コピー&ペーストやドラッグ&ドロップなどの外部由来の入力を検出・記録し、全ての操作をProof of Sequential Work (PoSW) 付きハッシュ鎖として記録します。

## 特徴

- **コピー&ペースト検出**: 外部からの入力を検出して記録
- **ハッシュ鎖による証明**: SHA-256 + PoSW による改ざん不可能なログ
- **デバイス認証**: ブラウザフィンガープリントによる端末識別
- **マルチタブ対応**: 複数ファイルの同時編集と個別証明
- **ブラウザ内コード実行**: C/C++, Python, JavaScript/TypeScript を実行可能
- **検証ページ**: エクスポートした証明ファイルの完全検証

## プロジェクト構成

```
typedcode/
├── packages/
│   ├── shared/     # 共有ライブラリ（型定義、TypingProof、Fingerprint）
│   ├── editor/     # メインエディタアプリケーション
│   ├── verify/     # 証明検証ページ
│   └── workers/    # Cloudflare Workers API
├── package.json    # ワークスペース設定
└── README.md
```

| パッケージ | 説明 |
|-----------|------|
| [@typedcode/shared](packages/shared/) | 暗号証明・型定義・フィンガープリント |
| [@typedcode/editor](packages/editor/) | Monaco Editorベースのメインアプリ |
| [@typedcode/verify](packages/verify/) | 証明ファイルの検証UI |
| @typedcode/workers | Turnstile認証API |

## クイックスタート

### 開発環境

```bash
# 依存関係のインストール
npm install

# 全パッケージを同時起動（エディタ + 検証ページ + Workers）
npm run dev

# 個別起動
npm run dev:editor    # http://localhost:5173
npm run dev:verify    # http://localhost:5174
npm run dev:workers   # Cloudflare Workers ローカル
```

### ビルド

```bash
# 全パッケージをビルド
npm run build

# 個別ビルド
npm run build:editor
npm run build:verify
```

### テスト

```bash
# shared パッケージのテスト
npm run test -w @typedcode/shared

# カバレッジ付き
npm run test:coverage -w @typedcode/shared
```

## 技術仕様

### ハッシュ鎖の仕組み

各イベントはPoSW（Proof of Sequential Work）付きでハッシュ化されます:

```
h_0 = SHA-256(deviceId || random)
PoSW_i = iterate(SHA-256, h_{i-1} || event_i, 10000)
h_i = SHA-256(h_{i-1} || event_i || PoSW_i)
```

- **deviceId**: 永続的なデバイスID（ブラウザフィンガープリント + UUID）
- **PoSW**: 10,000回の逐次ハッシュ計算（Web Workerで実行）
- **チェックポイント**: 100イベントごとに検証用チェックポイントを作成

### デバイス認証

初回アクセス時に以下の情報から永続的なデバイスIDを生成:

- UUID + タイムスタンプ
- User Agent, プラットフォーム, 言語設定
- CPUコア数, デバイスメモリ
- タイムゾーン, WebGL情報
- Canvas/WebGLフィンガープリント

デバイスIDはLocalStorageに保存され、他人の操作ログを流用することを防ぎます。

### 記録されるイベント

| カテゴリ | イベント例 |
|---------|-----------|
| テキスト操作 | `insertText`, `deleteContentBackward`, IME入力 |
| ナビゲーション | `cursorPositionChange`, `selectionChange` |
| 外部入力（検出） | `insertFromPaste`, `insertFromDrop` |
| 環境 | `windowResize`, `visibilityChange`, `focusChange` |
| 認証 | `humanAttestation`, `termsAccepted` |
| 実行 | `codeExecution`, `terminalInput` |

### エクスポート形式

**単一ファイル** (JSON):
```json
{
  "version": "3.2.0",
  "typingProofHash": "sha256...",
  "proof": {
    "events": [...],
    "signature": "..."
  },
  "fingerprint": { "hash": "...", "components": {...} },
  "checkpoints": [...]
}
```

**複数ファイル** (ZIP):
```
export.zip
├── proof.json
└── files/
    ├── main.c
    └── utils.h
```

## コード実行

TypedCodeはブラウザ内でコードを実行できます（サーバー不要）:

| 言語 | 実行環境 |
|-----|---------|
| C/C++ | Wasmer SDK + Clang (WASM) |
| Python | Pyodide (CPython → WASM) |
| JavaScript | ネイティブブラウザ実行 |
| TypeScript | SWC でトランスパイル後実行 |

## セキュリティ

- **外部入力検出**: paste/drop イベントを検出してログに記録
- **PoSW**: 逐次計算により事後的なログ生成を困難に
- **デバイスバインディング**: 初期ハッシュにデバイスIDを含めてログ流用を防止
- **チェックポイント**: サンプリング検証による高速な改ざん検出
- **HMAC署名**: サーバーサイドで認証トークンに署名

## ユースケース

- **プログラミング試験**: コピペ禁止の試験環境
- **教育課程**: 学習過程の記録と証明
- **コーディング課題**: 実装過程の透明性確保
- **行動研究**: タイピングパターンの分析

## 技術スタック

- **エディタ**: [Monaco Editor](https://microsoft.github.io/monaco-editor/) v0.55
- **ビルド**: [Vite](https://vitejs.dev/) v7
- **ターミナル**: [xterm.js](https://xtermjs.org/) v6
- **WASM**: [Wasmer SDK](https://wasmer.io/), [Pyodide](https://pyodide.org/)
- **テスト**: [Vitest](https://vitest.dev/) + happy-dom
- **バックエンド**: [Cloudflare Workers](https://workers.cloudflare.com/)

## 環境変数

| 変数 | 説明 |
|-----|------|
| `VITE_TURNSTILE_SITE_KEY` | Cloudflare Turnstile サイトキー |
| `VITE_API_URL` | Workers API エンドポイント |

## デプロイ

GitHub Actionsで自動デプロイ:
- `main` ブランチへのプッシュでGitHub Pagesにデプロイ
- Workersは `npm run deploy -w @typedcode/workers`

## ライセンス

MIT
