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

### EventType

エディタ上のあらゆる操作 (コンテンツ変更、カーソル、入力、ウィンドウ、認証、実行、キャプチャ、セッション) をカバーする union 型。**唯一の真実は [`src/types/events.ts`](src/types/events.ts) の定義**。

### InputType

W3C InputEvent の `inputType` に対応する union 型。許可リスト (`ALLOWED_INPUT_TYPES`) と禁止リスト (`PROHIBITED_INPUT_TYPES`) は [`src/typingProof/InputTypeValidator.ts`](src/typingProof/InputTypeValidator.ts) を参照。判定方針の根拠は [docs/adr/0005-input-type-policy.md](../../docs/adr/0005-input-type-policy.md)。

- `insertFromInternalPaste` (同一エディタ内のコピー＆ペースト) は許可される
- `insertFromPaste` などの外部入力は禁止 (ピュアタイピング判定 NG)

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
PoSW_i = iterate(SHA-256, h_{i-1} || event_i, POSW_ITERATIONS)
h_i = SHA-256(h_{i-1} || JSON(event_i) || PoSW_i)
```

- 各イベントのハッシュは前イベントのハッシュを含み、改ざん不能な鎖を形成
- JSON シリアライズはキー順序を決定的にし、再計算可能にする

### Proof of Sequential Work (PoSW)

各イベントごとに前ハッシュ + nonce を起点に SHA-256 を反復計算 (`POSW_ITERATIONS` 回) し、Web Worker で実行する。反復は前ハッシュに依存する直列計算なので、イベントの一括偽造や日時の遡及付与が困難になる。

定数の値、タイムアウト、nonce サイズなどの仕様は [docs/system-spec.md §4.4](../../docs/system-spec.md) を参照。

### チェックポイントシステム (ハイブリッドトリガ)

直前 cp からの経過 **イベント数 (`DEFAULT_MAX_EVENTS_PER_CHECKPOINT`)** または **経過時間 (`DEFAULT_MAX_CHECKPOINT_INTERVAL_MS`)** のいずれかが先に成立した時点で cp を作成する。評価は `recordEvent` 呼び出し時のみで、無入力中は cp は作られない。エクスポート時には最終イベント位置に cp が強制生成される。

サーバ署名 (ECDSA-P256) が付与された cp は時刻アンカリングの本体として機能し、後付けの改ざんを困難にする。

設計判断の根拠は [docs/adr/0001-hybrid-checkpoint-trigger.md](../../docs/adr/0001-hybrid-checkpoint-trigger.md)、署名方式は [docs/adr/0002-signed-checkpoints-with-ecdsa-p256.md](../../docs/adr/0002-signed-checkpoints-with-ecdsa-p256.md) を参照。

### 検証ステップ

1. **初期ハッシュ**がフィンガープリントハッシュと一致する
2. **シーケンス番号**が連続している (0, 1, 2, ...)
3. **タイムスタンプ**が単調増加している
4. **previousHash** が各イベントで計算値と一致する
5. **PoSW** が各イベントで `POSW_ITERATIONS` 反復として有効である
6. **署名済みチェックポイント** (任意) のサーバ署名と連結ハッシュが一貫している

### ピュアタイピング判定

以下を満たす場合のみ「ピュアタイピング」と判定:
- `insertFromPaste` イベントなし
- `insertFromDrop` イベントなし
- その他の禁止入力タイプを含まない

注: `insertFromInternalPaste` (同一エディタセッション内のコピー＆ペースト) はピュアタイピング判定を破らない。詳細は [docs/adr/0005-input-type-policy.md](../../docs/adr/0005-input-type-policy.md)。

### 定数

すべての公開定数の **唯一の真実** はソースコード:

- バージョン定数 (`PROOF_FORMAT_VERSION`, `STORAGE_FORMAT_VERSION`, `MIN_SUPPORTED_VERSION`, `POSW_ITERATIONS`): [`src/version.ts`](src/version.ts)
- チェックポイントトリガ (`DEFAULT_MAX_EVENTS_PER_CHECKPOINT`, `DEFAULT_MAX_CHECKPOINT_INTERVAL_MS`): [`src/typingProof/CheckpointManager.ts`](src/typingProof/CheckpointManager.ts)
- 集計表は [docs/system-spec.md §定数一覧](../../docs/system-spec.md)

`CheckpointManager.CHECKPOINT_INTERVAL` は `DEFAULT_MAX_EVENTS_PER_CHECKPOINT` の deprecated エイリアスとして維持されている (後方互換)。

## i18n

日本語と英語に対応した `I18nService` を提供します。

```typescript
import { I18nService, type SupportedLocale } from '@typedcode/shared';

const i18n = new I18nService(translations);  // ロケール自動検出
const text = i18n.t('common.cancel');
i18n.setLocale('en');
```
