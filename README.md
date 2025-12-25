# TypedCode

逐次タイピング証明エディタ - 全ての入力操作をハッシュ鎖として記録し、コピー&ペーストを検出

## 概要

TypedCodeは、**全ての入力が逐次タイピングされたことを暗号学的に証明する**エディタです。コピー&ペーストやドラッグ&ドロップなどの外部由来の入力を検出・記録し、全ての操作（文字入力、削除、カーソル移動、選択範囲変更など）をハッシュ鎖として記録します。

### 特徴

- 🔍 **コピー&ペースト検出**: 外部からの入力を検出して記録
- 🔗 **ハッシュ鎖による証明**: SHA-256を使用した改ざん不可能なログ
- 🔐 **デバイス認証**: ブラウザフィンガープリントによる端末識別（LocalStorage永続化）
- 📝 **詳細な操作記録**: 文字入力、削除、改行、カーソル移動などを全て記録
- ✅ **自動検証**: エクスポート時にハッシュ鎖の整合性を自動検証
- 📊 **リアルタイム統計**: イベント数と現在のハッシュをリアルタイム表示
- 🎨 **テーマ切り替え**: ライト/ダークテーマ対応
- 📋 **操作ログビューア**: リアルタイムで操作履歴を確認可能
- 🔒 **並列イベント処理**: 排他制御によるハッシュチェーンの整合性保証

## 技術仕様

### ハッシュ鎖の仕組み

各イベントは以下の形式でハッシュ化されます:

```
h_0 = SHA-256(deviceId || random)
h_i = SHA-256(h_{i-1} || event_i)
```

- `deviceId`: 永続的なデバイスID（ブラウザフィンガープリント + UUID）
- `random`: ランダム値（初期化時に生成）
- `h_0`: 初期ハッシュ（デバイスIDとランダム値から生成）
- `h_i`: i番目のイベントのハッシュ
- `event_i`: イベントデータ（JSON形式）

最終的に `h_final` から署名を生成し、全操作履歴の証明とします。

### デバイス認証

初回アクセス時に以下の情報から永続的なデバイスIDを生成：

- **UUID**: ランダムに生成された一意識別子
- **タイムスタンプ**: 生成時刻
- **安定したブラウザ情報**:
  - User Agent
  - プラットフォーム（OS）
  - 言語設定
  - CPUコア数
  - タイムゾーン
  - WebGLベンダー情報

デバイスIDはLocalStorageに保存され、ブラウザを再読み込みしても同じIDが使用されます。これにより、他人の操作ログを流用することを防ぎます。

### 記録されるイベント

#### ✅ 許可される操作（記録対象）

| 操作種別 | inputType | 説明 |
|---------|-----------|------|
| 文字入力 | `insertText` | 通常の文字入力 |
| 改行 | `insertLineBreak` | Enter キー |
| IME入力 | `insertFromComposition` | 日本語、中国語などの入力 |
| Backspace削除 | `deleteContentBackward` | カーソル前の文字を削除 |
| Delete削除 | `deleteContentForward` | カーソル位置の文字を削除 |
| 単語削除 | `deleteWordBackward` / `deleteWordForward` | 単語単位の削除 |
| 行削除 | `deleteHardLineBackward` | 行単位の削除 |
| Undo | `historyUndo` | 操作の取り消し |
| Redo | `historyRedo` | 操作のやり直し |
| カーソル移動 | `cursorPositionChange` | カーソル位置の変更 |
| 選択範囲変更 | `selectionChange` | テキスト選択 |

#### 🔍 外部入力操作（検出・記録対象）

| 操作 | イベント | 説明 |
|-----|---------|------|
| ペースト | `insertFromPaste` | Ctrl+V, 右クリックメニュー（検出して記録） |
| ドロップ | `insertFromDrop` | ドラッグ&ドロップ（検出して記録） |

### イベントデータ構造

各イベントは以下の情報を含みます:

```json
{
  "timestamp": 1234.56,
  "type": "contentChange",
  "inputType": "insertText",
  "data": "a",
  "rangeOffset": 10,
  "rangeLength": 0,
  "range": {
    "startLineNumber": 1,
    "startColumn": 11,
    "endLineNumber": 1,
    "endColumn": 11
  },
  "isMultiLine": false,
  "description": "文字入力",
  "previousHash": "abc123...",
  "hash": "def456..."
}
```

### エクスポートデータ形式

証明データは以下のJSON形式でエクスポートされます:

```json
{
  "version": "1.0.0",
  "proof": {
    "totalEvents": 150,
    "finalHash": "abc123...",
    "startTime": 0,
    "endTime": 5000.123,
    "signature": "def456...",
    "events": [...]
  },
  "fingerprint": {
    "hash": "デバイスIDハッシュ",
    "components": {
      "deviceId": "永続的なデバイスID",
      "fingerprintHash": "詳細なフィンガープリントハッシュ",
      "userAgent": "...",
      "platform": "...",
      "language": "ja",
      "hardwareConcurrency": 8,
      "deviceMemory": 8,
      "screen": {...},
      "timezone": "Asia/Tokyo",
      "canvas": "...",
      "webgl": {...},
      "fonts": [...]
    }
  },
  "content": "// コードの内容",
  "language": "javascript",
  "metadata": {
    "userAgent": "...",
    "timestamp": "2025-12-25T12:00:00.000Z"
  }
}
```

## 使い方

### 開発モード

```bash
npm install
npm run dev
```

### ビルド

```bash
npm run build
```

### 証明データのエクスポート

1. エディタで自由にコードを入力
2. 右上の「証明をエクスポート」ボタンをクリック
3. JSON形式でダウンロードされます

エクスポート時に自動的にハッシュ鎖の検証が実行されます。

## アーキテクチャ

### モジュール構成

- **[typingProof.js](src/typingProof.js)**: ハッシュ鎖の生成・管理・検証（排他制御付き）
- **[fingerprint.js](src/fingerprint.js)**: ブラウザフィンガープリント生成とデバイスID管理
- **[inputDetector.js](src/inputDetector.js)**: コピペ・ドロップの検出処理
- **[operationDetector.js](src/operationDetector.js)**: Monaco Editorのイベントから操作種別を推定
- **[logViewer.js](src/logViewer.js)**: 操作ログの表示
- **[themeManager.js](src/themeManager.js)**: ライト/ダークテーマの切り替え管理
- **[main.js](src/main.js)**: 全モジュールの統合とイベント処理

### セキュリティ

- **外部入力検出**: `paste`イベント、`drop`イベントを検出してログに記録
- **暗号学的ハッシュ**: SHA-256による改ざん検知
- **デバイス認証**: ブラウザフィンガープリントによる端末固有のIDを初期ハッシュに組み込み
- **検証可能性**: エクスポートデータから全操作履歴を検証可能
- **位置情報の記録**: すべての操作に位置情報を含めて順序の改ざんを防止
- **排他制御**: Promise チェーンによる並列イベントの順序保証
- **ログ流用防止**: デバイスIDが異なる場合、初期ハッシュが異なるため他人のログを流用不可

## ユースケース

- 📚 **プログラミング試験**: コピペ禁止の試験環境
- 🎓 **教育**: 学習過程の記録と証明
- 💼 **コーディング課題**: 実装過程の透明性確保
- 🔬 **研究**: タイピング行動の分析

## 技術スタック

- [Monaco Editor](https://microsoft.github.io/monaco-editor/): VSCodeと同じエディタエンジン
- [Vite](https://vitejs.dev/): 高速ビルドツール
- Web Crypto API: SHA-256ハッシュ計算

## ライセンス

MIT
