# @typedcode/verify

TypedCode 証明検証ページ - エクスポートされた証明ファイルを検証するWebアプリケーション

## 概要

TypedCode エディタからエクスポートされた証明ファイル（JSON/ZIP）を読み込み、ハッシュ鎖の整合性を暗号学的に検証するスタンドアロンアプリケーションです。

## 機能

- **ファイルアップロード**: ドラッグ&ドロップまたはファイル選択
- **ハッシュ鎖検証**: 全イベントのSHA-256ハッシュを再計算・検証
- **PoSW検証**: Proof of Sequential Work の検証
- **サンプリング検証**: チェックポイントを使用した高速検証
- **タイムライン**: シークバーでイベント履歴をナビゲート
- **可視化**: マウス軌跡やイベント分布のチャート表示
- **詳細表示**: 各イベントの詳細情報を確認

## 開発

```bash
# 開発サーバー起動（http://localhost:5174）
npm run dev

# ビルド
npm run build
```

## 検証プロセス

### 1. ファイル読み込み

```
ドラッグ&ドロップ / ファイル選択
    ↓
JSON パース / ZIP 展開
    ↓
isMultiFileProof() で形式判定
    ↓
検証開始
```

### 2. ハッシュ鎖検証

```typescript
// 各イベントについて以下を検証:
for (const event of events) {
  // 1. シーケンス番号チェック
  if (event.sequence !== i) → エラー

  // 2. タイムスタンプ連続性チェック
  if (event.timestamp < lastTimestamp) → エラー

  // 3. previousHash チェック
  if (event.previousHash !== computedHash) → エラー

  // 4. PoSW 検証
  const poswValid = await verifyPoSW(hash, eventData, event.posw);
  if (!poswValid) → エラー

  // 5. ハッシュ再計算
  computedHash = SHA256(previousHash + JSON(eventData + posw));
  if (computedHash !== event.hash) → エラー
}
```

### 3. サンプリング検証（高速モード）

チェックポイント間の一部区間のみを検証:

```
チェックポイント: [0, 100, 200, 300, ...]
    ↓
ランダムに3区間を選択
    ↓
各区間の開始ハッシュから終了ハッシュを再計算
    ↓
期待される終了ハッシュと比較
```

## ファイル構成

```
src/
├── main.ts           # エントリーポイント、ファイル処理
├── verification.ts   # ハッシュ鎖検証ロジック
├── seekbar.ts        # タイムラインシークバー
├── charts.ts         # チャート描画（マウス軌跡等）
├── ui.ts             # UI ユーティリティ
├── elements.ts       # DOM 要素キャッシュ
└── types.ts          # 検証ページ固有の型
```

## UI コンポーネント

### ファイルアップロード

```html
<div id="drop-zone">
  ファイルをドロップまたはクリックして選択
</div>
```

### 検証結果表示

- **成功**: 緑色のチェックマーク、検証されたイベント数
- **失敗**: 赤色のエラー、失敗位置と理由

### シークバー

イベントタイムラインをスライダーで操作:

```
|----[thumb]--------------|
 0                       end
       ↓
   選択したイベントの詳細を表示
```

### チャート

- **マウス軌跡**: X-Y座標の時系列プロット
- **イベント分布**: 時間あたりのイベント密度

## 対応フォーマット

### 単一ファイル (ExportedProof)

```json
{
  "version": "3.2.0",
  "typingProofHash": "...",
  "proof": {
    "events": [...],
    "signature": "..."
  },
  "fingerprint": {...},
  "checkpoints": [...]
}
```

### 複数ファイル (MultiFileExportedProof)

```json
{
  "version": "3.1.0",
  "type": "multi-file",
  "files": {
    "main.c": { ... },
    "utils.h": { ... }
  },
  "tabSwitches": [...],
  "fingerprint": {...}
}
```

## 検証結果

### VerificationResult

```typescript
interface VerificationResult {
  valid: boolean;
  message?: string;
  errorAt?: number;        // エラー発生イベント番号
  event?: StoredEvent;     // 問題のイベント
  expectedHash?: string;   // 期待されるハッシュ
  computedHash?: string;   // 計算されたハッシュ
  sampledResult?: {        // サンプリング検証結果
    sampledSegments: SampledSegmentInfo[];
    totalEventsVerified: number;
  };
}
```

### 検証失敗の原因

| エラー種別 | 説明 |
|-----------|------|
| Sequence mismatch | イベント順序の不整合 |
| Timestamp violation | タイムスタンプの逆行 |
| Previous hash mismatch | 前ハッシュの不一致 |
| PoSW verification failed | PoSW検証失敗 |
| Hash mismatch | ハッシュ値の不一致 |

## 技術詳細

### PoSW 検証

Web Worker を使用せず、メインスレッドでフォールバック検証:

```typescript
// Worker なしでの検証
let hash = await computeHash(previousHash + eventData + nonce);
for (let i = 1; i < iterations; i++) {
  hash = await computeHash(hash);
}
return hash === expectedIntermediateHash;
```

### プログレス表示

長時間の検証中、進捗をリアルタイム表示:

```typescript
await proof.verify((current, total, hashInfo) => {
  updateProgress(current, total);
  updateHashDisplay(hashInfo.computed);
});
```

## 依存関係

- **@typedcode/shared**: 型定義、TypingProof
- **vite**: ビルドツール
- **typescript**: 型チェック
