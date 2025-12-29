# @typedcode/shared

TypedCode の共有ライブラリ - 型定義、暗号証明、デバイスフィンガープリント

## 概要

このパッケージは TypedCode プロジェクト全体で使用される共有コンポーネントを提供します:

- **TypingProof**: ハッシュ鎖の生成・検証エンジン
- **Fingerprint**: ブラウザフィンガープリントとデバイスID管理
- **型定義**: イベント、証明データ、設定の型定義

## インストール

モノレポ内での使用:

```typescript
import { TypingProof, Fingerprint } from '@typedcode/shared';
import type { FingerprintComponents, StoredEvent } from '@typedcode/shared';
```

## 主要コンポーネント

### TypingProof

ハッシュ鎖とProof of Sequential Work (PoSW) を管理するメインクラス。

```typescript
import { TypingProof } from '@typedcode/shared';

// インスタンス作成と初期化
const proof = new TypingProof();
await proof.initialize(fingerprintHash, fingerprintComponents);

// イベント記録
await proof.recordEvent({
  type: 'contentChange',
  inputType: 'insertText',
  data: 'a',
  description: '文字入力',
});

// ハッシュ鎖の検証
const result = await proof.verify();
console.log(result.valid); // true

// 証明データのエクスポート
const exported = await proof.exportProof(finalContent);
```

#### 主要メソッド

| メソッド | 説明 |
|---------|------|
| `initialize(hash, components)` | フィンガープリントで初期化 |
| `recordEvent(event)` | イベントを記録してハッシュ更新 |
| `recordHumanAttestation(data)` | 人間認証をイベント#0として記録 |
| `verify(onProgress?)` | ハッシュ鎖を完全検証 |
| `verifySampled(checkpoints, count?)` | チェックポイントでサンプリング検証 |
| `exportProof(content)` | 証明データをエクスポート |
| `isAllowedInputType(type)` | 許可された入力タイプか判定 |
| `isProhibitedInputType(type)` | 禁止された入力タイプか判定 |
| `getStats()` | 現在の統計情報を取得 |
| `reset()` | 状態をリセット |

#### PoSW (Proof of Sequential Work)

各イベントは10,000回の逐次ハッシュ計算を経て記録されます。これにより、事後的なログ生成が計算量的に困難になります。

```typescript
// PoSW計算はWeb Workerで非同期実行
const posw = await proof.computePoSW(previousHash, eventDataString);
// { iterations: 10000, nonce: '...', intermediateHash: '...', computeTimeMs: 50 }
```

### Fingerprint

ブラウザフィンガープリントとデバイスID管理。

```typescript
import { Fingerprint } from '@typedcode/shared';

// 永続的なデバイスIDを取得（LocalStorage保存）
const deviceId = await Fingerprint.getDeviceId();

// 詳細なフィンガープリントを収集
const components = await Fingerprint.collectComponents();
// { userAgent, language, screen, canvas, webgl, fonts, ... }

// フィンガープリントハッシュを生成
const hash = await Fingerprint.generate();
```

#### 収集される情報

| カテゴリ | 項目 |
|---------|------|
| ブラウザ | userAgent, language, platform |
| ハードウェア | hardwareConcurrency, deviceMemory |
| 画面 | width, height, colorDepth, devicePixelRatio |
| 環境 | timezone, timezoneOffset |
| レンダリング | Canvas fingerprint, WebGL info |
| その他 | fonts, cookieEnabled, maxTouchPoints |

## 型定義

### イベント型

```typescript
import type {
  EventType,        // 'contentChange' | 'cursorPositionChange' | ...
  InputType,        // 'insertText' | 'insertFromPaste' | ...
  StoredEvent,      // 記録されたイベント
  RecordEventInput, // recordEvent()への入力
} from '@typedcode/shared';
```

### 証明データ型

```typescript
import type {
  ExportedProof,          // 単一ファイルエクスポート
  MultiFileExportedProof, // 複数ファイルエクスポート
  VerificationResult,     // 検証結果
  CheckpointData,         // チェックポイント
} from '@typedcode/shared';
```

### 型ガード

```typescript
import { isMultiFileProof } from '@typedcode/shared';

if (isMultiFileProof(data)) {
  // data は MultiFileExportedProof
  console.log(data.files);
}
```

## テスト

```bash
# Watch モード
npm run test

# 単発実行
npm run test:run

# カバレッジ
npm run test:coverage
```

### テスト構成

- `typingProof.test.ts`: ハッシュ鎖、PoSW、イベント記録
- `fingerprint.test.ts`: デバイスID、フィンガープリント収集
- `types.test.ts`: 型ガード関数

## ファイル構成

```
src/
├── index.ts          # エクスポート
├── types.ts          # 型定義（600行）
├── typingProof.ts    # ハッシュ鎖エンジン（1,150行）
├── fingerprint.ts    # フィンガープリント（250行）
├── poswWorker.ts     # PoSW Web Worker（170行）
└── __tests__/
    ├── setup.ts              # テストセットアップ
    ├── typingProof.test.ts
    ├── fingerprint.test.ts
    └── types.test.ts
```

## 技術詳細

### ハッシュ計算

```
h_0 = SHA-256(fingerprint || random)
PoSW_i = iterate(SHA-256, h_{i-1} || event_i, 10000)
h_i = SHA-256(h_{i-1} || JSON(event_i) || PoSW_i)
```

### 決定的JSON変換

ハッシュ計算の一貫性を保証するため、オブジェクトのキーは常にソートされます:

```typescript
// 内部で使用される deterministicStringify
{ b: 1, a: 2 } → '{"a":2,"b":1}'
```

### チェックポイント

100イベントごとにチェックポイントを作成し、サンプリング検証を可能にします:

```typescript
const result = await proof.verifySampled(
  checkpoints,
  3  // 検証する区間数
);
```

## 依存関係

- **実行時**: なし（ブラウザAPIのみ使用）
- **開発時**: vitest, happy-dom, @vitest/coverage-v8
