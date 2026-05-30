# TypedCode システム仕様書

タイピングの全過程を改ざん耐性のある形で記録し、後から第三者が「このコードは確かにキー打鍵で書かれた」ことを検証できるシステムの設計仕様。

このドキュメントは、署名済みチェックポイント (Phase 1〜5) 統合後の最新状態を反映する。

---

## 1. システム目的

TypedCode は、ブラウザ上のコードエディタにおける編集操作 (キーストローク、貼り付け、選択、削除など) を **逐次** ハッシュチェーンに記録し、その記録を後から **暗号学的に検証可能** にすることを目的とする。最終的に「このソースコードは copy/paste ではなく、人間がキー打鍵で順番に入力した」という主張を、外部の検証者が再現可能な手順で確認できる。

### 想定ユースケース
- 学習目的: タイピング演習・コーディング試験
- 教育目的: コーディング能力の客観的記録
- 採用試験: ライブコーディング課題の事後検証
- AI 生成物との分別: 「全部 LLM に書かせていない」ことの根拠提示

### スコープ外
- 思考内容の証明 (内容のロジック品質や正しさは扱わない)
- 「人間 X が打鍵した」という個人同定 (キーストロークパターンは収集するが個人特定の証明はしない)
- 完全な不正防止 (後述の限界節を参照)

---

## 2. 脅威モデル

### 想定攻撃者
- 出力された proof ファイルを編集して、不正な記録を「正しい」と見せかけたい
- LLM/別エディタで書いたコードを、あたかも自分が打鍵したかのように proof を捏造したい
- 過去の他人の proof を流用したい
- Workers 署名サーバが将来停止した後に proof を改ざんしたい

### 想定信頼境界
| 構成要素 | 信頼度 |
|----------|--------|
| 録画時のクライアント (ブラウザ実行コード) | 半信頼 (ユーザは自分の DevTools を操作可能、コードは公開) |
| Cloudflare Workers (`/api/checkpoint/sign`) | 信頼 (秘密鍵が安全に管理されている前提) |
| Cloudflare KV | 高信頼 (eventual consistent を許容) |
| 公開鍵レジストリ (`registry.ts`) | 信頼 (git 履歴で追跡、PR レビュー) |
| 検証者 (verify ページ / verify-cli) | 自由 (誰でも実行可能、決定的な検証ロジック) |

### 守れる性質
- 過去に発行された proof の **後追い改ざん検出** (本仕様の主目的)
- 改ざんされた proof は決定的検証ロジックで検出可能
- 編集セッション中のサーバ署名取得時刻による **時刻アンカリング**

### 守れない性質 (限界)
- リアルタイムに正規システムを使って自動入力ボット等で proof を **生成中に** 改ざんすること (本仕様の対象外、別途 Turnstile / 人間性検証 / タイピングパターン分析が補完する)
- 検証者が公開鍵を入手できない/Workers が永久停止した状況での本仕様内検証 (鍵バンドル運用で緩和)

---

## 3. システム構成

5 パッケージで構成される npm workspaces モノレポ。

| Package | 役割 |
|---------|------|
| `@typedcode/shared` | 型定義、ハッシュチェーン、PoSW、署名検証、共通ユーティリティ。ブラウザ/Node 両方で動く |
| `@typedcode/editor` | Monaco エディタ + 録画ロジック + エクスポート機能 (Vite, ブラウザ) |
| `@typedcode/verify` | proof 検証 UI (Vite, ブラウザ) |
| `@typedcode/verify-cli` | proof 検証 CLI (Node ≥24) |
| `@typedcode/workers` | Cloudflare Workers (Turnstile + 署名チェックポイント + 検証 endpoint) |

### データの流れ (概要)
```
[editor] ─ recordEvent ─→ HashChain → PoSW → Checkpoint
              │
              ├──→ SignedCheckpointService ──→ POST /api/checkpoint/sign
              │                                       ↓
              │                            [Workers] ECDSA-P256 sign + KV firstSeenAt
              │                                       ↓
              │←──────── envelope (payload + signature + keyId) ───
              │
              ↓ exportProof()
       [proof.zip] = proof.json + screenshots + README

[verify] ←─ load ─ [proof.zip]
       │
       ├ Phase 1: metadata (typingProofHash, fingerprint, event metadata)
       ├ Phase 2: hash chain integrity (sequence, timestamp, prevHash, hash recompute)
       ├ Phase 3: content replay
       ├ Phase 4: PoSW recompute (full mode only)
       ├ Phase 5: signed checkpoint signature & chain
       └ Phase 6: temporal anchoring analysis
```

---

## 4. 記録フェーズ

### 4.1. イベント (Event) の収集

エディタ上の操作はすべて「イベント」として記録される。25 種類のイベントタイプがある:

**カテゴリ別**:
- **コンテンツ変更**: `contentChange`, `contentSnapshot`, `externalInput`, `templateInjection`
- **カーソル/選択**: `cursorPositionChange`, `selectionChange`
- **キー入力**: `keyDown`, `keyUp`, `mousePositionChange`
- **ウィンドウ**: `focusChange`, `visibilityChange`, `windowResize`
- **システム**: `editorInitialized`, `networkStatusChange`
- **認証**: `humanAttestation`, `preExportAttestation`, `termsAccepted`
- **実行**: `codeExecution`, `terminalInput`
- **キャプチャ**: `screenshotCapture`, `screenShareStart`, `screenShareStop`, `screenShareOptOut`
- **セッション**: `sessionResumed`, `copyOperation`

各イベントは `EventHashData` 構造で表現される:
```typescript
interface EventHashData {
  sequence: number;        // 連続インデックス (0, 1, 2, ...)
  timestamp: number;       // performance.now() ベースの相対 ms
  type: EventType;         // 上記 25 種類
  inputType: InputType | null;  // contentChange 系の詳細 (insertText, deleteContentBackward など 26 種)
  data: string | object | null; // type 別の本体
  rangeOffset: number | null;
  rangeLength: number | null;
  range: TextRange | null;
  previousHash: string | null;  // 直前イベントのハッシュ (チェーンの肝)
  posw: PoSWData;          // Proof of Sequential Work (後述)
}
```

加えて `StoredEvent` には UI 表示用のメタ情報 (`description`, `selectedText` 等) が含まれるが、**ハッシュ計算には使わない**。

### 4.2. 初期ハッシュ (ルート) の構築

セッション開始時に **fingerprint** からチェーンルートを生成する。

**Fingerprint** ([Fingerprint.ts]): ブラウザ環境を表すコンポーネント集約 (userAgent, screen, timezone, canvas, webgl, fonts, ...) を JSON 化して SHA-256 ハッシュ。決定的にユーザ環境を表す 64-hex 文字列。

**初期チェーンハッシュ生成**:
```typescript
nonce = crypto.getRandomValues(32 bytes) → 64-hex
initialEventChainHash = SHA256(fingerprintHash + nonce)
```

このルートが events[0].previousHash に入る。**nonce は proof ファイルに保存される** (再検証で必要)。

**意義**:
- 同じ環境でも nonce が違えばルートが異なる → セッションごとに一意
- nonce + fingerprint の両方が proof に含まれ、検証時に「fingerprint → ルート」を再構成して照合 → **fingerprint 改ざん検出**
- 異なる proof からのイベント流用も nonce が違うので検出される

### 4.3. ハッシュチェーン (Hash Chain)

各イベントの hash は以下で計算:

```typescript
eventData = {sequence, timestamp, type, inputType, data, rangeOffset,
             rangeLength, range, previousHash, posw}
eventString = deterministicStringify(eventData)  // キーを alphabetic sort
event.hash = SHA256(previousHash + eventString)
```

ポイント:
- `posw` フィールドも hash 入力に含まれる → PoSW の値が後から書き換わると hash 不一致になる
- `deterministicStringify` でオブジェクトキーをソート → JSON シリアライズの順序ゆらぎを排除
- previousHash で完全な連鎖を形成 → 任意 1 イベントの改ざんは以降のすべてのハッシュを破壊

### 4.4. Proof of Sequential Work (PoSW)

各イベントの記録には、追加で **10,000 回の連続 SHA-256 反復** を実行する。

**計算** (Web Worker で非同期実行):
```typescript
nonce = crypto.getRandomValues(16 bytes) → 32-hex
hash = SHA256(previousHash + eventDataString + nonce)
for (i = 1; i < 10000; i++) {
  hash = SHA256(hash)
}
intermediateHash = hash
```

**保存** (`event.posw`):
```typescript
{
  iterations: 10000,       // 必ず 10000 (POSW_ITERATIONS 固定)
  nonce: string,           // 32-hex
  intermediateHash: string,// 10000 回反復後のハッシュ
  computeTimeMs: number    // 参考値
}
```

**意義**:
- 各イベントに「最低限の計算時間」を強制 (約 5〜30ms / event 程度)
- 大量のイベントを瞬時に偽造することを困難にする (10000 events なら最低 50 秒の連続計算)
- 並列化困難 (一つのイベントの PoSW 内部は前ハッシュに依存して直列)
- ただし、Workers/サーバなど高性能環境では並列で複数 event 分を計算できるため、絶対的な防御ではない (時刻アンカリングと併用)

### 4.5. チェックポイント (Checkpoint)

以下のいずれかが先に成立した時点で自動作成される構造 (ハイブリッドトリガ)。

- 直前 cp から **100 イベント** が経過 (`DEFAULT_MAX_EVENTS_PER_CHECKPOINT`)
- 直前 cp から **10 秒** が経過 (`DEFAULT_MAX_CHECKPOINT_INTERVAL_MS`)

時間トリガは `recordEvent` の呼び出し時にのみ評価されるため、無入力中は新しい cp は作られない。最終 cp は `exportProof` 時に強制発火する。

```typescript
interface CheckpointData {
  eventIndex: number;     // 0-indexed イベント位置
  hash: string;           // 対応 event の hash
  timestamp: number;      // 対応 event の timestamp
  contentHash: string;    // SHA256(event.data) — 該当イベントのデータ部のハッシュ
  signature?: SignedCheckpointEnvelope;  // サーバ署名 (後述、optional)
}
```

エクスポート時にも最終 event 位置のチェックポイントが追加で生成される。export 直前の `cleanupForExport` は同一 `eventIndex` の重複を除去するのみで、トリガ間隔に依存しない。

**意義**:
- 高速検証 (将来のサンプリング検証) の足場
- **本仕様では「checkpoint 単体での verifier 早期成功」は許可しない** (PR #60 のハードニング)。常に全 event のハッシュチェーンを再計算する
- 後述する署名済みチェックポイントの土台

### 4.6. 署名済みチェックポイント (Signed Checkpoint)

各チェックポイント作成直後に、editor は Cloudflare Workers へ署名要求を送る。

**Editor 側ペイロード** (`SignedCheckpointInput`):
```typescript
{
  sessionId, tabId,                 // editor 側 ID (UUID)
  checkpointIndex,                  // セッション内連番 (0, 1, 2, ...)
  eventIndex,
  initialEventChainHash,            // proof ルート
  chainHash: event.hash,            // この checkpoint の event hash
  contentHash,
  previousSignedCheckpointHash,     // 直前 envelope の hash (null = 初回)
  totalEventsSincePrevious,
  clientTimestamp                   // editor 側 ISO 時刻
}
```

**Workers 側処理** (`/api/checkpoint/sign`):
1. スキーマ検証
2. KV から `session:{sessionId}` を取得
3. **firstSeenAt 確定**: 既存があればその値、なければ `now` で初回書込
4. checkpointIndex 単調性チェック (best-effort)
5. signedCount セッション上限チェック (50,000)
6. `payload = { ...input, serverTimestamp: now, firstSeenAt, poswIterations: 10000, version: 1 }` を構築
7. `signature = ECDSA-P256.sign(privateKey, deterministicStringify(payload))`
8. KV 更新 (TTL **7 日**)
9. envelope を返却

**Envelope 形式**:
```typescript
interface SignedCheckpointEnvelope {
  payload: SignedCheckpointPayload;  // 上記 v1
  signature: string;                  // hex (ECDSA-P256, ASN.1 DER, ~70-72 bytes → 140-144 hex)
  keyId: string;                      // 例: "tcp-202608-xxxxxx"
  algorithm: 'ECDSA-P256';
  publicKeyJwk?: JsonWebKey;          // optional 同梱 (long-term verifiability)
  publicKeyValidFrom?: string;
  publicKeyValidUntil?: string;
}
```

**意義**:
- payload の `serverTimestamp` は **サーバが付与** するので、クライアント単独で偽造不可
- `firstSeenAt` は KV 初回書込時に確定し、**それ以降同じ sessionId に対して不変** → sessionId 流用攻撃を検出可能
- ECDSA-P256 署名により外部検証可能 (公開鍵は git で永続管理)

---

## 5. 保存形式

### 5.1. ローカルストレージ (実行中)
- **sessionStorage `typedcode-tabs`**: タブ状態 (lightweight V2 フォーマット、events は IndexedDB から取得)
- **IndexedDB `typedcode-session`**: イベント本体、screenshots、tabSwitches、session メタデータ
- **localStorage**: なし (proof データは sessionStorage/IndexedDB)

ローカル保存は **生存中のみ意味があり、検証可能性とは独立**。エクスポート時に proof.json へ凝縮される。

### 5.2. エクスポート ZIP

```
my-code.zip
├── filename.{c,py,...}      // ソースコード本体
├── filename_proof.json      // proof データ (下記詳細)
├── README.md                // 人間可読の説明 (ja/en)
└── screenshots/             // スクリーンショット (オプション)
    ├── 0001.png
    └── ...
```

### 5.3. `proof.json` (単一ファイル形式)

```typescript
interface ExportedProof {
  version: '1.0.0';
  typingProofHash: string;          // proofData 全体の SHA-256
  typingProofData: {
    finalContentHash: string;       // SHA256(最終コンテンツ)
    initialHashNonce: string;       // 64-hex
    initialEventChainHash: string;  // = events[0].previousHash
    finalEventChainHash: string;    // = 最終 event の hash
    deviceId: string;               // = fingerprintHash
    metadata: ProofMetadata;        // 集計値 (検証時に再計算照合)
  };
  proof: {
    totalEvents: number;
    finalHash: string;              // = finalEventChainHash
    startTime: number;
    endTime: number;
    signature: string;              // 旧形式の互換用 (現バージョンでは構造的署名)
    events: StoredEvent[];          // 全イベント列
  };
  fingerprint: {
    hash: string;
    components: FingerprintComponents;
  };
  metadata: {
    userAgent: string;
    timestamp: string;
    isPureTyping: boolean;
  };
  checkpoints?: CheckpointData[];   // 33 event 間隔、各 signature? 付き
}
```

### 5.4. マルチファイル形式

複数タブ同時にエクスポートした場合は `MultiFileExportedProof` (`type: 'multi-file'`) で、各ファイルが独立した `proof.events[]` + `checkpoints[]` を持つ。タブ間切替は `tabSwitches: TabSwitchEvent[]` に記録。

---

## 6. 検証フェーズ

### 6.1. 3 検証モード

| Mode | 目的 | PoSW 反復再計算 | 検証時間 (1000 events) |
|------|------|------------------|------------------------|
| `fast` | 改ざん検出のみ | スキップ | ~50ms |
| `audit` | 部分的 PoSW 検証 (未実装、現状 full と同等) | (将来) 決定的サンプリング | 中 |
| `full` | 完全検証 | 全 event を再計算 | ~10〜60 秒 |

モード非依存で常に実行されるのは: メタデータ照合、ハッシュチェーン再計算、内容再生、署名チェックポイント検証。**`fast` で省略するのは PoSW 反復 (1 event あたり 10000 回 SHA-256) のみ**。

### 6.2. 検証 6 レイヤ

```
[1] verifyTypingProofHash + verifyInitialHashRoot + verifyProofMetadata
[2] verifyChain (skipPosw 任意)
[3] verifyFinalChainHash
[4] verifyContentReplay
[5] verifyCheckpoints (unsigned)
[6] verifyProofSignedCheckpoints
```

**Layer 1: メタデータ整合性**
- `typingProofHash === SHA256(typingProofData)` を再計算照合
- `finalContentHash === SHA256(content)` を再計算照合
- fingerprint components から hash を再計算 → 申告 hash と一致
- `initialEventChainHash === SHA256(fingerprintHash + nonce)` を照合
- `metadata` (pasteEvents, dropEvents, insertEvents, ...) を全イベント走査で再カウントして照合

**Layer 2: ハッシュチェーン整合性**
- 各 event について:
  - `event.sequence === i` (連番)
  - `event.timestamp >= lastTimestamp` (単調)
  - `event.previousHash === 計算上の hash` (連鎖)
  - `event.posw.iterations === 10000` (PoSW 反復数申告)
  - `event.posw.intermediateHash === 10000 回反復後の hash` ← **fast モードではスキップ**
  - `event.hash === SHA256(previousHash + deterministicStringify(eventData_with_posw))`

**Layer 3: 最終ハッシュ照合**
- `proof.finalHash === 計算済み最終 chain hash` (二重申告のクロスチェック)
- `typingProofData.finalEventChainHash === 計算済み最終 chain hash`

**Layer 4: 内容再生**
- `contentSnapshot` / `templateInjection` / `contentChange` のみ抽出して順次適用
- 各 contentChange は range/offset に基づきテキスト挿入/削除を再現
- 最終再生コンテンツが `proof.content` と完全一致

**Layer 5: チェックポイント整合性 (未署名分)**
- 各 checkpoint について:
  - `events[checkpoint.eventIndex].hash === checkpoint.hash`
  - `events[checkpoint.eventIndex].timestamp === checkpoint.timestamp`
  - `SHA256(event.data) === checkpoint.contentHash`
  - `eventIndex` 連番 (チェックポイント配列内で重複/逆順なし)

**Layer 6: 署名済みチェックポイント検証**
署名 envelope がある checkpoint のみが対象 (anchored)。一つでもあれば「temporal anchoring 利用」と判定。
- 各 envelope について:
  - payload version === 1
  - payload.poswIterations === 10000
  - payload.initialEventChainHash === proof root
  - payload.chainHash === events[eventIndex].hash
  - payload.contentHash === enclosing checkpoint の contentHash
  - keyId 解決 (envelope 同梱 publicKeyJwk → registry → fail)
  - `crypto.subtle.verify` で署名検証
  - 鍵 revoked かつ serverTimestamp >= revokedAt なら fail。前なら warning 付き通過
  - 鍵 validUntil < serverTimestamp なら fail
- envelope 配列全体:
  - 全 envelope で `sessionId` 一致
  - 全 envelope で `firstSeenAt` 一致 ← sessionId 流用防御
  - `checkpointIndex` 厳密増加
  - `eventIndex` 厳密増加
  - `serverTimestamp` 厳密増加
  - `previousSignedCheckpointHash` が直前 envelope の payload hash と一致 (連鎖)
- temporal 分析 (warning レベル):
  - `serverSpan = lastServerTimestamp - firstServerTimestamp`
  - `clientSpan = lastClientTimestamp - firstClientTimestamp`
  - `ratio = serverSpan / clientSpan`
  - `ratio < 0.1` または `serverSpan < 60s` かつ `clientSpan > 600s` の時、**post-hoc batch signing 疑い** フラグ

### 6.3. 検証成功判定

- `verifyProofFile` 全レイヤを `&&` で組み合わせる
- 署名済み checkpoint は `anchored=true` のとき必須レイヤ。`anchored=false` (旧 proof など) では他レイヤで成立すれば valid
- レイヤ間優先順位: metadata → chain → finalHash → checkpoint → content → signedCheckpoint
- いずれかが false なら、エラー位置 (event index) とメッセージを返す

---

## 7. 耐改ざん性 (Defense in Depth)

各レイヤがどんな攻撃を検出するかをマトリクスで整理する。

| 攻撃シナリオ | 検出するレイヤ |
|-----------|--------------|
| 任意 event の data を書き換え | Layer 2 (hash 再計算で不一致) |
| event の sequence を入れ替え | Layer 2 (sequence チェック) |
| event の timestamp を逆行 | Layer 2 (timestamp 単調性) |
| event を 1 つ削除 (チェーン全体を再構築できれば原理上通る) | Layer 1 (metadata カウント不一致)、Layer 4 (content 再生不一致)、Layer 6 (signed checkpoint の chainHash 不一致) |
| 全 event を別 proof から流用 | Layer 1 (fingerprint hash 不一致 or initialEventChainHash 不一致) |
| 最終 content だけを書き換え | Layer 4 (replay 結果と一致しない) |
| metadata の pasteEvents を 0 に偽装 | Layer 1 (再カウントで矛盾) |
| 偽の posw.intermediateHash を入れる | Layer 2 full mode (PoSW 再計算で不一致) |
| 偽の posw.iterations 数を申告 | Layer 2 fast/full 共通 (iterations === 10000 必須) |
| signature を別 proof から流用 | Layer 6 (initialEventChainHash 不一致, chainHash 不一致) |
| envelope を並び替え/削除 | Layer 6 (`previousSignedCheckpointHash` 連鎖違反) |
| **sessionId 流用** で別人の checkpoint chain 末尾に自分の envelope を append | Layer 6 (`firstSeenAt` 不一致 → KV 由来の不変値で防御) |
| 全 envelope を proof 完成後にバッチで署名取得 (post-hoc) | Layer 6 (serverSpan が clientSpan と乖離 → warning フラグ) |
| Workers サーバを将来停止させた後に proof 改ざん | Layer 6 (公開鍵 registry が git 永続管理、envelope 同梱で完全オフライン検証可能) |

**多層性 (defense in depth)**: 一つのレイヤを攻撃者が突破しても、他レイヤが直交的に検出する。たとえば event の data 改ざんは Layer 2 の hash 不一致と Layer 4 の content 不一致と Layer 6 の chainHash 不一致の **3 経路で検出される**。

---

## 8. 信頼保証と限界 (重要)

### 8.1. 強い保証 (Cryptographic Guarantees)

以下は SHA-256/ECDSA-P256 の安全性が破られない限り **数学的に保証**される。

- **改ざん検出**: 過去に発行された proof の任意 1 ビットの改ざんは、Layer 2/4/6 のいずれかで決定的に検出される
- **流用検出**: 別の fingerprint / sessionId / initialEventChainHash 由来のデータ流用は決定的に検出される
- **時刻アンカリング (signed checkpoints 利用時)**: 各 envelope の `serverTimestamp` は「サーバが署名要求を受け取った時刻」を証明する → proof は最古の `serverTimestamp` 以降に存在していたことが証明される
- **長期検証可能性**: 公開鍵 registry が git で永続管理され、envelope に公開鍵を同梱可能 → Cloudflare Workers が停止しても verify-cli で永続的に検証可能

### 8.2. 弱い保証 (Probabilistic / Heuristic)

- **`fast` モード**: PoSW の正しさは検証されない。攻撃者が「PoSW iterations: 10000」と申告しつつ偽の intermediateHash を入れた場合、fast モードでは通る。しかし event の hash 入力に posw が含まれるため、`SHA256(previousHash + eventData_with_posw)` の照合で実質的に「申告 PoSW 値が proof 全体と一貫している」ことは保証される。**ただし「実際に 10000 回反復したか」は確認しない**
- **`audit` モード** (未実装): 将来的に決定的サンプリング (verifier 提供 nonce で seed) で PoSW を一部検証する設計余地あり
- **post-hoc 検出**: temporal ratio は統計的ヒューリスティック。閾値 0.1 は経験則。攻撃者が稼働時間と同等のサーバ時間をかけて段階的に署名取得すれば検出回避可能
- **タイピングパターン分析** (verify 側に別途実装): キーストロークの dwell/flight time から「人間っぽさ」を判定するが、これは UI 表示用の参考値で proof valid 判定には使われない

### 8.3. 守れない性質 (Out of Scope)

- **リアルタイム不正の防止**: 攻撃者が録画中に自動入力スクリプトを走らせる、外部からテキストを inject する等は、正規システムを使う以上 proof は valid になる。これに対しては:
  - Turnstile 人間認証 (タブ作成時、エクスポート時)
  - スクリーンショット定期取得 (30 秒間隔)
  - フォーカス変化 / ウィンドウサイズ変化の記録
  - タイピングパターン分析 (人間離れした規則性を warning 表示)
  - といった補助情報が proof に含まれるが、これらは proof valid 判定とは独立した「読み手の判断材料」である
- **個人同定**: fingerprint は環境同定であってユーザ個人を識別するものではない
- **コード品質保証**: タイピングしたという事実のみを証明する。書かれたコードが正しい/良いという保証は一切しない

### 8.4. 鍵管理の前提

- 本仕様の安全性は **署名秘密鍵が漏洩しないこと** に依存する
- 漏洩発覚時の対処: `revokedAt` を設定して registry に残す。`serverTimestamp < revokedAt` の envelope は warning 付きで trust、`>=` は fail
- 鍵ローテーション: 新旧並走運用 (新鍵 validFrom = 旧鍵 validUntil)

---

## 9. 運用

### 9.1. Cloudflare Workers セットアップ

1. **KV namespace 作成**:
   ```bash
   wrangler kv namespace create CHECKPOINT_SESSIONS
   wrangler kv namespace create CHECKPOINT_SESSIONS --preview
   ```
   出力 ID を `packages/workers/wrangler.toml` の対応箇所に投入
2. **本番鍵生成**: `npm run gen-checkpoint-key -w @typedcode/workers`
   - 出力された公開鍵 entry を `packages/shared/src/checkpointKeys/registry.ts` に append、PR レビュー
   - 秘密鍵 JWK を `wrangler secret put CHECKPOINT_SIGNING_KEY_JWK`
   - keyId を `wrangler secret put CHECKPOINT_SIGNING_KEY_ID`
3. **デプロイ**: `npm run deploy:prod -w @typedcode/workers`

### 9.2. ローカル開発セットアップ (各開発者)

1. dev 鍵生成: `npm run gen-checkpoint-key -w @typedcode/workers`
2. 出力された公開鍵 entry を `packages/shared/src/checkpointKeys/localKeys.ts` に append
3. **skip-worktree**: `git update-index --skip-worktree packages/shared/src/checkpointKeys/localKeys.ts` (誤コミット防止)
4. 出力された秘密鍵 JWK / keyId を `packages/workers/.dev.vars` に貼る
5. dev KV namespace 作成 (上記 9.1 ステップ 1 と同じ)、`wrangler.toml` 編集
6. **skip-worktree**: `git update-index --skip-worktree packages/workers/wrangler.toml`
7. `npm run dev` で 3 サーバ起動 (editor:5173, verify:5174, workers:8787)

### 9.3. proof の検証 (検証者側)

**Web 版**: `https://(verify-host)/` にアクセスして proof.zip を drag & drop。デフォルト `full` モード。設定メニューから `fast` / `audit` に切替可能。

**CLI 版**:
```bash
typedcode-verify my-code.zip                 # full モード (デフォルト)
typedcode-verify my-code.zip --mode fast     # PoSW 省略、高速
typedcode-verify my-code.zip --mode audit    # 将来用 (現状 full と同等)
```

オフライン環境では verify-cli を historical commit でチェックアウトすれば、その時点の公開鍵 registry がバンドルされた状態で過去 proof を検証可能。

### 9.4. 鍵 revoke 運用

1. 漏洩発覚した keyId について `registry.ts` の該当 entry を更新:
   ```typescript
   {
     keyId: '...',
     status: 'revoked',
     revokedAt: '2026-XX-XXTHH:MM:SS.000Z',  // 漏洩判明時刻
     // 他は変更しない
   }
   ```
2. PR レビューしてマージ → verify ページ次回読込で反映 (cacheTtlSec: 86400)
3. 既存 proof:
   - `serverTimestamp < revokedAt` → warning 付きで通る (漏洩前なので trust)
   - `serverTimestamp >= revokedAt` → fail

---

## 10. 用語集 & 定数

| 用語 | 意味 |
|------|------|
| **proof** | ExportedProof または MultiFileExportedProof。エクスポートされた検証可能な記録 |
| **event** | エディタ操作 1 つを表す最小単位。25 種類 |
| **chain hash** | event.hash。previousHash + eventData の SHA-256 |
| **PoSW** | Proof of Sequential Work。10000 回 SHA-256 反復 |
| **checkpoint** | 直前 cp から 100 event か 10 秒のいずれかが先に到達した時点で作られる「中間スナップショット」 |
| **signed checkpoint** | サーバが ECDSA-P256 で署名した checkpoint。temporal anchoring の本体 |
| **envelope** | SignedCheckpointEnvelope。署名済み payload + 署名 + keyId |
| **firstSeenAt** | サーバが initial に sessionId を見た時刻。KV 由来で不変 |
| **anchored** | proof に signed checkpoint が 1 つ以上含まれている状態 |
| **post-hoc batch signing** | proof 完成後に複数 envelope を短時間で一括取得する攻撃。temporal ratio で検出試行 |

### 定数一覧

| 定数 | 値 | 場所 |
|------|-----|------|
| `POSW_ITERATIONS` | 10000 | `version.ts` |
| `DEFAULT_MAX_EVENTS_PER_CHECKPOINT` | 100 | `CheckpointManager.ts` |
| `DEFAULT_MAX_CHECKPOINT_INTERVAL_MS` | 10_000 | `CheckpointManager.ts` |
| `SIGNED_CHECKPOINT_FORMAT_VERSION` | 1 | `version.ts` |
| `SESSION_TTL_SECONDS` | 604800 (7日) | `workers/src/checkpoint.ts` |
| `SESSION_MAX_CHECKPOINTS` | 50000 | `workers/src/checkpoint.ts` |
| `POST_HOC_RATIO_THRESHOLD` | 0.1 | `signedCheckpoints.ts` |
| `POST_HOC_MIN_SERVER_SPAN_MS` | 60_000 | `signedCheckpoints.ts` |
| `POST_HOC_MIN_CLIENT_SPAN_MS` | 600_000 | `signedCheckpoints.ts` |
| `PROOF_FORMAT_VERSION` | '1.0.0' | `version.ts` |
| `STORAGE_FORMAT_VERSION` | 1 | `version.ts` |

注: `CheckpointManager.CHECKPOINT_INTERVAL` は `DEFAULT_MAX_EVENTS_PER_CHECKPOINT` の値を持つ deprecated エイリアスとして維持される。

---

## 11. 関連ドキュメント

- [packages/workers/README.md](../packages/workers/README.md) — Workers のセットアップとデプロイ手順
- [packages/shared/README.md](../packages/shared/README.md) — shared API リファレンス
- [packages/verify/README.md](../packages/verify/README.md) — 検証 UI の使い方
- [packages/verify-cli/README.md](../packages/verify-cli/README.md) — CLI 検証ツール
- [CLAUDE.md](../CLAUDE.md) — Claude Code 用プロジェクト概要

---

## 12. 変更履歴

| Date | Phase | 概要 |
|------|-------|------|
| 2026-05-XX (PR #60) | hardening | 初期ハッシュ root バインド強化、content replay 必須化、PoSW iterations 強制、metadata 再計算、sampled 検証の単独成功不許可 |
| 2026-05-28 | Phase 1+1.5+6 | shared 型、ECDSA-P256 検証、公開鍵 registry、テスト |
| 2026-05-28 | Phase 2 | fast/audit/full モード + skipPosw を verifier に結線 |
| 2026-05-28 | Phase 3 | Workers `/api/checkpoint/sign` + `/api/checkpoint/public-keys` + KV |
| 2026-05-28 | Phase 4 | Editor の SignedCheckpointService + TabManager 配線 |
| 2026-05-28 | Phase 5 | 検証 UI (Anchoring カード、モードセレクタ) |
| 2026-05-29 | follow-up | fetch bind / dropdown UI / localKeys split |
