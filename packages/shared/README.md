# @typedcode/shared

TypedCode のコアライブラリ。型定義・暗号証明エンジン・検証ロジック・デバイスフィンガープリンティングを提供します。

## インストール

ワークスペース内で利用されるため、エディタ・検証アプリ・CLI から `@typedcode/shared` として import します。

```typescript
import { TypingProof, Fingerprint, AttestationService } from '@typedcode/shared';
import type { FingerprintComponents, StoredEvent, ExportedProof } from '@typedcode/shared';
```

## 構成

### TypingProof

ハッシュチェーンと Proof of Sequential Work (PoSW) を司るエンジン。モジュラ構成でハッシュ・PoSW・チェックポイント・検証・統計を内部で分担しています。

```typescript
const proof = new TypingProof();
await proof.initialize(fingerprintHash, fingerprintComponents);

// イベントを記録
await proof.recordEvent({
  type: 'contentChange',
  inputType: 'insertText',
  data: 'a',
  description: 'Character input',
});

// チェーン整合性を検証
const result = await proof.verify();

// 証明データをエクスポート
const exported = await proof.exportProof(finalContent);
```

**主なメソッド:**

| メソッド | 説明 |
|--------|-------------|
| `initialize(hash, components)` | フィンガープリントで初期化 |
| `recordEvent(event)` | イベントを記録しハッシュチェーンを進める |
| `recordHumanAttestation(data)` | 人間認証を event #0 として記録 |
| `verify(onProgress?)` | フルチェーン検証 |
| `verifySampled(checkpoints, count?)` | チェックポイントを使ったサンプリング検証 |
| `exportProof(content)` | 証明データをエクスポート |
| `isAllowedInputType(type)` | 許可された入力タイプか |
| `isProhibitedInputType(type)` | 禁止された入力タイプか |
| `getStats()` | イベント統計を取得 |
| `getTypingStatistics()` | タイピング固有の統計を取得 |
| `reset()` | チェーンとストレージをリセット |

### Fingerprint

ブラウザフィンガープリントとデバイス ID の管理。

```typescript
// 永続デバイス ID を取得 (localStorage 保存)
const deviceId = await Fingerprint.getDeviceId();

// 構成要素を収集
const components = await Fingerprint.collectComponents();

// ハッシュを生成
const hash = await Fingerprint.generate();
```

**収集するデータ:**
- ブラウザ: userAgent, language, languages, platform
- ハードウェア: hardwareConcurrency, deviceMemory, maxTouchPoints
- 画面: width, height, colorDepth, devicePixelRatio
- 環境: timezone, timezoneOffset, cookieEnabled, doNotTrack
- 描画: Canvas フィンガープリント、WebGL vendor / renderer
- フォント: システムフォント検出結果

### AttestationService

Cloudflare Turnstile による人間認証の検証クライアント。

```typescript
const attestation = new AttestationService(apiUrl);

// アテステーション署名の検証
const result = await attestation.verify(attestationData);
```

### ファイル処理

証明ファイル (JSON / ZIP) の解析と判定。

```typescript
import {
  parseJsonString,
  parseZipBuffer,
  isProofFile,
  isMultiFileProof,
  isProofFilename,
  extractFirstProofFromZip,
} from '@typedcode/shared';

// JSON を解析
const proof = parseJsonString(jsonContent);

// ZIP を解析
const proof = await parseZipBuffer(arrayBuffer);

// マルチファイル証明かどうかの判定
if (isMultiFileProof(proof)) {
  // マルチファイル処理
}
```

### 検証関数

```typescript
import { verifyProofFile, verifyChain, verifyPoSW } from '@typedcode/shared';

// フル検証
const result = await verifyProofFile(proof);

// チェーンのみ検証
const chainResult = await verifyChain(events, fingerprint);

// PoSW のみ検証
const poswResult = await verifyPoSW(event);
```

## 型定義

### EventType (25 種類)

```typescript
type EventType =
  // Content
  | 'contentChange' | 'contentSnapshot' | 'externalInput' | 'templateInjection'
  // Cursor
  | 'cursorPositionChange' | 'selectionChange'
  // Input
  | 'keyDown' | 'keyUp' | 'mousePositionChange'
  // Window
  | 'focusChange' | 'visibilityChange' | 'windowResize'
  // System
  | 'editorInitialized' | 'networkStatusChange'
  // Authentication
  | 'humanAttestation' | 'preExportAttestation' | 'termsAccepted'
  // Execution
  | 'codeExecution' | 'terminalInput'
  // Capture
  | 'screenshotCapture' | 'screenShareStart' | 'screenShareStop' | 'screenShareOptOut'
  // Session
  | 'sessionResumed' | 'copyOperation';
```

### InputType (26 種類)

```typescript
// 許可される入力タイプ (20 種類)
type AllowedInputType =
  | 'insertText' | 'insertLineBreak' | 'insertParagraph' | 'insertTab'
  | 'insertFromComposition' | 'insertCompositionText' | 'deleteCompositionText'
  | 'deleteContentBackward' | 'deleteContentForward'
  | 'deleteWordBackward' | 'deleteWordForward'
  | 'deleteSoftLineBackward' | 'deleteSoftLineForward'
  | 'deleteHardLineBackward' | 'deleteHardLineForward'
  | 'deleteByDrag' | 'deleteByCut'
  | 'historyUndo' | 'historyRedo'
  | 'insertFromInternalPaste';  // 同一エディタ内のコピー＆ペースト (許可)

// 外部入力 (禁止、5 種類)
type BlockedInputType =
  | 'insertFromPaste' | 'insertFromDrop' | 'insertFromYank'
  | 'insertReplacementText' | 'insertFromPasteAsQuotation';

// その他 (1 種類)
// 'replaceContent'
```

### 主要な型

```typescript
import type {
  StoredEvent,            // ハッシュチェーン付きで記録されたイベント
  ExportedProof,          // 単一ファイル証明形式
  MultiFileExportedProof, // マルチファイル証明形式
  VerificationResult,     // 検証結果
  CheckpointData,         // ハッシュチェーン中間点
  PoSWData,               // Proof of Sequential Work データ
  HumanAttestationData,   // 人間認証データ
  FingerprintComponents,  // ブラウザフィンガープリント構成要素
  SignedCheckpointEnvelope, // 署名済みチェックポイント
} from '@typedcode/shared';
```

## テスト

```bash
npm run test
npm run test:coverage
```

## 技術仕様

### ハッシュチェーンアルゴリズム

```
h_0 = SHA-256(fingerprint || random)
PoSW_i = iterate(SHA-256, h_{i-1} || event_i, 10000)
h_i = SHA-256(h_{i-1} || JSON(event_i) || PoSW_i)
```

- 各イベントのハッシュは前イベントのハッシュを含み、改ざん不能な鎖を形成
- JSON シリアライズはキー順序を決定的にし、再計算可能にする

### Proof of Sequential Work (PoSW)

| 項目 | 値 |
|----------|-------|
| 反復回数 | 1 イベントあたり 10,000 回 |
| Nonce | 16 バイトのランダム値 |
| タイムアウト | 30 秒 |
| 実行環境 | Web Worker (UI ブロックなし) |

PoSW により、イベントの一括偽造や日時の遡及付与が困難になります。各イベントの計算は前ハッシュに依存して直列であるためです。

### チェックポイントシステム (ハイブリッドトリガ)

| 項目 | 値 |
|----------|-------|
| トリガ | 直前 cp から **100 イベント** または **10 秒** のいずれかが先に成立 |
| 評価タイミング | `recordEvent` 呼び出し時のみ (無入力中は作成されない) |
| 内容 | `eventIndex`, `hash`, `timestamp`, `contentHash`, 任意の `signature` |

時刻トリガにより、無入力区間でもチェックポイント間隔の上限が 10 秒に固定されます。エクスポート時には最終イベントの位置にチェックポイントが強制生成されます。

サーバ署名 (ECDSA-P256) が付与されたチェックポイントは時刻アンカリングの本体として機能し、後付けの改ざんを困難にします。

### 検証ステップ

1. **初期ハッシュ**がフィンガープリントハッシュと一致する
2. **シーケンス番号**が連続している (0, 1, 2, ...)
3. **タイムスタンプ**が単調増加している
4. **previousHash** が各イベントで計算値と一致する
5. **PoSW** が各イベントで有効である (10,000 反復)
6. **署名済みチェックポイント** (任意) のサーバ署名と連結ハッシュが一貫している

### ピュアタイピング判定

以下を満たす場合のみ「ピュアタイピング」と判定:
- `insertFromPaste` イベントなし
- `insertFromDrop` イベントなし
- その他の禁止入力タイプを含まない

注: `insertFromInternalPaste` (同一エディタセッション内のコピー＆ペースト) はピュアタイピング判定を破りません。

### 定数

```typescript
export const PROOF_FORMAT_VERSION = '1.0.0';
export const STORAGE_FORMAT_VERSION = 1;
export const MIN_SUPPORTED_VERSION = '1.0.0';
export const POSW_ITERATIONS = 10000;

// ハイブリッド・チェックポイントトリガ (先に成立した方で発火):
export const DEFAULT_MAX_EVENTS_PER_CHECKPOINT = 100;       // N
export const DEFAULT_MAX_CHECKPOINT_INTERVAL_MS = 10_000;   // T (ms)
// `CheckpointManager.CHECKPOINT_INTERVAL` は
// `DEFAULT_MAX_EVENTS_PER_CHECKPOINT` の deprecated エイリアスとして維持。
```

## i18n

日本語と英語に対応した `I18nService` を提供します。

```typescript
import { I18nService, type SupportedLocale } from '@typedcode/shared';

const i18n = new I18nService(translations);  // ロケール自動検出
const text = i18n.t('common.cancel');
i18n.setLocale('en');
```
