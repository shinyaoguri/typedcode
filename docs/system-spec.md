# TypedCode システム仕様書

タイピングの全過程を改ざん耐性のある形で記録し、後から第三者が「このコードは確かにキー打鍵で書かれた」ことを検証できるシステムの設計仕様。

このドキュメントは、署名済みチェックポイント (Phase 1〜5) と**試験モード** (ADR-0006〜0011) 統合後の最新状態を反映する。試験を含む動作モード (casual/class/assignment/exam) は URL パスで分岐する (ADR-0011)。

---

## 1. システム目的

TypedCode は、ブラウザ上のコードエディタにおける編集操作 (キーストローク、貼り付け、選択、削除など) を **逐次** ハッシュチェーンに記録し、その記録を後から **暗号学的に検証可能** にすることを目的とする。外部の検証者が再現可能な手順で確認できる主張は、強度の異なる**三層** (ADR-0020) に分かれる:

- **整合性 (決定的)**: この編集列はこのエディタ内でこの順序で記録され、エクスポート後 1 bit も改変されていない
- **時刻アンカー (決定的)**: 記録はサーバ署名された時間窓の中に存在した (試験は T0 束縛が regime を担う)
- **著述性 (advisory)**: 打鍵列が転写でなく著述に見えるか — **確率的な参考情報であり「人間が書いた」ことの証明ではない** (分析層 = ADR-0009 と読み手の判断に委ねる)

「人間がキー打鍵で順番に入力した」という素朴な一文は上記三層の合成であり、検証 UI / CLI はこれを 1 つの PASS/FAIL に圧縮せず三層で併記する (overclaim の構造的抑止)。

### 想定ユースケース
- 学習目的: タイピング演習・コーディング試験
- 教育目的: コーディング能力の客観的記録
- 採用試験: ライブコーディング課題の事後検証
- AI 生成物との分別: 「全部 LLM に書かせていない」ことの根拠提示
- **試験モード** (ADR-0006〜0011): 大学試験で生成 AI / 自動入力の不正を抑止する。封印された問題を監督コードで解錠し、解答チェーンを「その問題・試験開始 (T0) 以降」に暗号学的に束縛する。ローカル完結・サーバ非依存・匿名で、本人性は外部 (Moodle 提出) が担う。試験は動作モードの 1 つ (`/exam`) で、モードは URL パスで確定する (ADR-0011)。詳細は後述「試験モード」節。

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
- **(試験モード)** 試験開始 (T0) 前に問題を読んで事前 solve したい / 配布と異なる別問題の解答をすり替えたい / 過去回・他人の試験 proof を流用したい / 提出後に改ざんしたい

### 想定信頼境界
| 構成要素 | 信頼度 |
|----------|--------|
| 録画時のクライアント (ブラウザ実行コード) | 半信頼 (ユーザは自分の DevTools を操作可能、コードは公開) |
| Cloudflare Workers (`/api/checkpoint/sign`) | 信頼 (秘密鍵が安全に管理されている前提) |
| Cloudflare KV | 高信頼 (eventual consistent を許容) |
| 公開鍵レジストリ (`registry.ts`) | 信頼 (git 履歴で追跡、PR レビュー) |
| 検証者 (verify ページ / verify-cli) | 自由 (誰でも実行可能、決定的な検証ロジック) |
| **(試験モード)** 出題者鍵レジストリ (`examAuthorityKeys/registry.ts`) | 信頼 (問題パッケージ署名鍵。cp 署名鍵とは別系統。git 永続管理) |
| **(試験モード)** 試験監督 (proctor) | 信頼 (唯一の真の air gap。同一マシン・窓内の不正の最終防衛線。T0 に監督コードを口頭/板書で解禁) |
| **(試験モード)** Moodle 提出 | 信頼 (本人性と提出時刻の上限を外側で担う。TypedCode は本人同定をしない) |

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

エディタ上の操作はすべて「イベント」として記録される。29 種類のイベントタイプがある:

**カテゴリ別**:
- **コンテンツ変更**: `contentChange`, `contentSnapshot`, `externalInput`, `templateInjection`
- **カーソル/選択**: `cursorPositionChange`, `selectionChange`
- **キー入力**: `keyDown`, `keyUp`, `mousePositionChange`
- **ウィンドウ**: `focusChange`, `visibilityChange`, `windowResize`, `fullscreenChange` (試験モードのフルスクリーン状態。ADR-0008)
- **システム**: `editorInitialized`, `networkStatusChange`
- **試験**: `examOpened` (試験モードで封印問題を開封した瞬間 = T0 を記録。`#1` として記録される可読な監査印。権威ある束縛は root + `proof.exam`。ADR-0006)
- **環境/自動化**: `environmentProbe` (起動時ワンショット。`navigator.webdriver` と自動化グローバル痕跡。ADR-0007 / ADR-0009 の automation 分析器が消費。加えて **editor-assist 宣言** `editorAssist` = Monaco 支援機能 (補完/スニペット/括弧自動閉じ/inlineSuggest 等) の解決済み実効状態を `editor-assist/1` スキーマで宣言する。取得不可は null。ADR-0019)
- **認証**: `humanAttestation`, `preExportAttestation`, `termsAccepted`
- **振り返り**: `reflectionNote` (提出前セルフレビューで学生が任意に書く振り返り。チェーンに焼かれ改ざん検出つき。空文字は記録しない。ADR-0022)
- **実行**: `codeExecution` (ADR-0021: `phase:'start'` と `phase:'result'` の 2 イベント。result は outcome (success/failure/error/aborted)・exitCode・elapsedMs を持ち「失敗→修正→成功」のデバッグサイクルを導出可能にする。旧 proof の data 無しは start 相当), `terminalInput`
- **キャプチャ**: `screenshotCapture`, `screenShareStart`, `screenShareStop`, `screenShareOptOut`
- **セッション**: `sessionResumed`, `copyOperation`

各イベントは `EventHashData` 構造で表現される:
```typescript
interface EventHashData {
  sequence: number;        // 連続インデックス (0, 1, 2, ...)
  timestamp: number;       // performance.now() ベースの相対 ms
  type: EventType;         // 上記 29 種類
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

**試験モードのルート (ADR-0006 / ADR-0012)**: 試験モードでは root 式が変わり、問題パッケージと監督コードを焼き込む。**`rootBinding` で v1/v2 を分岐**する:
```typescript
packageHash = SHA256(deterministicStringify(signing core))  // signing core = manifest − {signature, publicKeyJwk}
// v1 (単一問題, ADR-0006):
initialEventChainHash = SHA256(fingerprintHash + nonce + packageHash + startToken)
// v2 (N問バンドル, ADR-0012 B-2): 末尾に per-problem の problemContentHash を連結
initialEventChainHash = SHA256(fingerprintHash + nonce + packageHash + startToken + problemContentHash)
```
`problemContentHash` 省略時 (v1) は v1 とバイト一致。**現行 editor は新規 exam セッションを v2 で焼く** (旧 proof は rootBinding 未設定 = v1 とみなす)。genesis は **監督コード入力の瞬間 (= T0)**。root が `startToken` を含むためコード入力まで計算できず、セッション初期化ではなくコード入力時にルートを確定する。検証器は **`proof.exam` の有無で root 式を分岐**し、`proof.exam.rootBinding` で v1/v2 を分岐する (casual proof は従来式)。`PROOF_FORMAT_VERSION` は 1.1.0 (詳細は「試験モード」節)。

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
  signature: string;                  // hex (ECDSA-P256, raw r‖s = IEEE P1363, 64 bytes → 128 hex。ASN.1 DER ではない)
  keyId: string;                      // 例: "tcp-202608-xxxxxx"
  algorithm: 'ECDSA-P256';
  publicKeyJwk?: JsonWebKey;          // optional 同梱。registry 一致の cross-check 用であって信頼の源ではない
  publicKeyValidFrom?: string;
  publicKeyValidUntil?: string;
}
```

**意義**:
- payload の `serverTimestamp` は **サーバが付与** するので、クライアント単独で偽造不可
- `firstSeenAt` は KV 初回書込時に確定し、**それ以降同じ sessionId に対して不変** → sessionId 流用攻撃を検出可能
- ECDSA-P256 署名により外部検証可能 (公開鍵は git で永続管理)

### 4.7. 試験モード: 封印問題パッケージとチェーン根束縛 (ADR-0006)

試験モードは **三者分業** で「紙の試験」に近づける: **TypedCode = 改ざん耐性のある答案 + 記録するペン / 試験監督 (proctor) = air gap の担い手 / Moodle = 本人性と提出時刻**。決めるのは「解答が、配布された“その問題”に、“試験開始 (T0) 以降”に紐づく」ことを **ライブサーバ依存ゼロ・匿名** で proof に焼き込むこと。事前 solve・別問題すり替え・過去回流用・提出後改ざんを構造的に閉じる (窓内・同一マシンの忠実な転写は proctor + 後段分析に委ねる)。

**(1) 封印問題パッケージ (`*.tcexam`, JSON)**: 出題者が問題平文を封印して Moodle で事前配布する。
```jsonc
{
  "formatVersion": 1, "examId": "...", "problemId": "p1", "variant": null,
  "kdf":    { "algorithm": "argon2id", "salt": "<hex16B>", "params": { "memKiB": 65536, "iterations": 3, "parallelism": 1 } },
  "cipher": { "algorithm": "AES-256-GCM", "iv": "<hex12B>", "ciphertext": "<base64>" },
  "releaseTime": "<ISO T0>", "deadline": "<ISO T1>", "allowed": { "languages": ["c", "python"] },
  "keyId": "exam-...", "algorithm": "ECDSA-P256", "publicKeyJwk": { /* 任意同梱 */ }, "signature": "<hex>"
}
```
- **署名 / packageHash の対象は同一の canonical core** = manifest から `{signature, publicKeyJwk}` を除いたもの (`deterministicStringify`)。任意同梱の publicKeyJwk・署名値そのものに packageHash が依存しない。
- KDF は **Argon2id** (純 JS の `@noble/hashes`、メモリハードで GPU 並列耐性)、暗号は **AES-256-GCM**。
- **`releaseTime` / `deadline` の意味 (ADR-0013)**: `releaseTime` は **パッケージ発行時刻 (issued-at) かつ出題者鍵有効性アンカー** (`checkExamKeyValidityAtRelease` が `releaseTime` 時点の鍵 validFrom/validUntil/revokedAt を判定する)。`deadline` は **advisory な提出窓の上限**で、`verifyExamBinding` の time-box は失格条件にしない。**実際の開始/締切の管理は Moodle が唯一の正**で、TypedCode 側は「いつ解いたか」(イベントのタイムスタンプ・署名 cp の serverTimestamp) を記録するに留まる。`/author` はスケジュールを尋ねず、`releaseTime`=生成時刻・`deadline`=オープン (遠い未来 `2999-12-31`) を入れる。manifest フォーマットは据え置き (ADR-0013)。

**(2) 監督コード (`startToken`)**: **8 文字 Crockford Base32 (`I L O U` 除外, 40 bit)**。CSPRNG 生成、T0 に監督が口頭/板書で解禁。入力は正準化 (大文字化 + 区切り除去) して KDF / root / `proof.exam` の全経路で一致させる。**コードの正しさは AES-GCM 認証タグで判定** (誤コード → 復号失敗)。平文 manifest に token のコミットメント (`H(token)`) は**置かない** (低エントロピーゆえ総当たりで漏れる)。封印は「T0 までの数分だけ確実に持つ消費期限つき」であり永続金庫ではない。

**(3) 解錠とチェーン根束縛**: 受験者は事前に `.tcexam` をローカル取込し、T0 に監督コードを入力する。
1. `examAuthorityKeys` で **package 署名を検証** (本物の問題)。
2. Argon2id で監督コードから鍵を導出し **AES-256-GCM 復号** (誤コードは GCM で失敗)。
3. **genesis = この瞬間**。root を v1=`SHA256(… + packageHash + startToken)` / v2=末尾に `+ problemContentHash` で確定 (現行 editor は v2、§4.2)。
4. `#0 = humanAttestation` を **best-effort** で記録 (Turnstile は T0 前に取得・不達でも合成して #0 を残す = サーバを critical path に置かない)。`#1 = examOpened` を記録。問題を表示。

**(4) `proof.exam` ブロック / 検証**: 復号後平文の SHA-256・packageHash・startToken 等を proof に保存し、grader が提出物 (+ 公開 package) だけで self-contained に検証する。形式は §5.3、検証フローは §6.4 を参照。

**(5) 出題者鍵レジストリ** (`examAuthorityKeys/registry.ts`): cp 署名鍵 (`checkpointKeys`) とは**別系統**だが同型 (append-only、`status: 'active'|'revoked'`、git 永続)。問題パッケージ署名の真正性を担う。生成は `generate-exam-authority-key.mjs`、パッケージ生成は `make-exam-package.mjs`。

**(6) サーバ非依存**: T0 に必要なのは監督コードのみ (100 名同時・不安定網でもサーバゼロ)。署名 cp や Turnstile は best-effort、**export 前認証も試験モードでは best-effort 化** (Workers 不達でも提出 ZIP を生成できる)。

### 4.8. 授業モード: 平文問題配布 (ADR-0014)

授業モード (`/class`) は「**監督下だが封印しない**(問題は公開)」モード (ADR-0011 §3)。試験の暗号機構 (封印・監督コード・根束縛) は持たず、問題配布の真正性は **tier ① 自己申告** (ADR-0011 §4①) に拠る。

- **配布フォーマット (`*.tcclass`, JSON)**: `{ schema: 'tcclass/1', classId, allowed:{languages}, bundle }`。`bundle` は試験と**同一の `ExamBundle` (`tcexam-exam/1`)** を**平文**で内包する (暗号化・署名なし)。受講者は `/class` の非ブロッキングローダで読み込む (監督コード不要・スキップ可)。`parseClassPackage` は構造検証のみ。
- **タブ展開**: 各問を 1 タブで開く (1問1タブ)。class タブは **casual タブ** (`examContext` なし → 通常の genesis、**root 束縛なし**)。スターターコードは `templateInjectionEvent` で「与えられた雛形」として注入し、`templateName='tcclass/${classId}/${problemId}'` が **self-asserted problemId を proof に残す**。`mode:'class'` は自己申告で記録される。**新イベント型/proof フィールドは増えず `PROOF_FORMAT_VERSION` は据え置き** (完全後方互換)。
- **能力差** (`core/mode.ts`): casual に対し問題表示 (`problemPanel`) と**受動的 fullscreen 記録** (`fullscreenTracking` だが要求バナーは出さない = `fullscreenBanner:false`) を足す。タブは緩 (`tabLock:false`)、汎用 DL も残す。教室・多人数・不安定網ゆえ export は best-effort。
- **オーサリング**: `/author` は同じ問題から封印 (`.tcexam`) と未封印 (`.tcclass`) の両方を出せる (`buildClassPackage`、examId を classId に流用)。
- **保証**: class proof の保証は低い (formative)。AI 写経は防げない (ADR-0011 の割り切り)。「上に偽れない (試験の保証は暗号束縛由来)・取り違えは Moodle が拾う」ので署名/封印は不要。

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
  version: '1.0.0' | '1.1.0';       // 1.1.0 = 試験モードの root 式に対応したビルド (ADR-0006)
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
  checkpoints?: CheckpointData[];   // 各 signature? 付き
  exam?: ExamProofBlock;            // 試験モード時のみ (ADR-0006)
}

// 試験モード proof のみ持つ。grader が self-contained に束縛を検証するための値 (ADR-0006)
interface ExamProofBlock {
  examProofVersion: 1;
  examId: string; problemId: string; variant: string | null;
  packageHash: string;          // SHA256(deterministicStringify(signing core))
  problemContentHash: string;   // 復号後**平文**問題の SHA-256 (事前公開しない)
  startToken: string;           // 監督コード (正準形)。T0 後は公開値なので保存して self-contained 化
  rootBinding: 'v1' | 'v2';     // v1=単一(ADR-0006), v2=N問バンドルで problemContentHash も root に連結(ADR-0012)。現行 editor は v2。未設定は v1 とみなす
}
```

`startToken` を保存しても、束縛の価値 (「T0 前に知り得ない」) は損なわれない (公開は T0 後)。保存により grader はコードを out-of-band に受け取る運用が不要になり、コード紛失で root 検証不能になるリスクも消える。

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
- `initialEventChainHash` の照合。root 式は proof の種別で分岐 (`verifyInitialHashRoot`):
  - **exam** (`proof.exam` あり): 試験モードの root 式 (v1 = `SHA256(fp ‖ nonce ‖ packageHash ‖ startToken)`、v2 = 末尾に `‖ problemContentHash`。`proof.exam.rootBinding` で分岐。§4.2)。proof 自己完結・package 不要
  - **anchored casual/class** (`proof.sessionStartToken` あり, ADR-0017): `SHA256(fp ‖ nonce ‖ serverNonce)`。加えてトークンの ECDSA を **registry で検証** (registry-only = C1。未登録 keyId は拒否)、鍵の有効期間/失効を `issuedAt` を anchor に判定、`token.fingerprintHash === proof.fingerprint.hash` (端末束縛)。成立で `rootAnchored=true`
  - **従来 casual/class**: `SHA256(fp ‖ nonce)`。`rootAnchored=false`
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
  - keyId 解決: **信頼アンカーは registry のみ**。未登録 keyId は (envelope に publicKeyJwk が
    同梱されていても) fail。registry にある場合のみ同梱 JWK の一致を必須にする (すり替え検出)。
    署名は常に registry の公開鍵で検証する (攻撃者の自己署名 envelope を valid にしない)
  - `crypto.subtle.verify` で署名検証
  - 鍵 validFrom > serverTimestamp なら fail (未来鍵)
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
- アンカー密度分析 (ADR-0016、warning レベル / 任意で strict-fail):
  - `coverageRatio` (= 最終署名 cp の eventIndex / 全 event 数) は **末尾 1 点でも 1.0** になり薄いアンカーを見逃すため、
    署名 cp が指す **eventIndex / serverTimestamp のギャップ**を別途見る。
  - `maxGapEvents` = 連続署名 cp 間の eventIndex 最大ギャップ (先頭=event0 境界 / 末尾=最終 event 境界 を含む)。
    末尾 1 点なら先頭ギャップ大、先頭 1 点なら末尾ギャップ大で、どちらの偏りも捕捉する。
  - `maxGapServerMs` = 連続署名 cp 間 serverTimestamp の最大ギャップ (先頭は firstSeenAt 起点)。
  - `firstAnchorLatencyEvents` = 最初の署名 cp までの未アンカー event 数。
  - `firstAnchorLatencyServerMs` = firstSeenAt → 初アンカーの ms。現アーキでは構造的に ~0 (session/start アンカー = ADR-0017 で意味化)。計測のみで gate には使わない。
  - **疎判定 `sparse`**: `maxGapEvents > 500` または `maxGapServerMs > 50s` または `firstAnchorLatencyEvents > 500`
    (= ハイブリッドトリガ 100 events / 10,000 ms の 5 倍。保守的な置きで実ログ調整待ち)。
  - 既定は **warning のみ** (valid は true)。`requireAnchorDensity` opt-in (exam/採点) のとき `sparse` で `valid=false`。
    `signedCount === 0` (未アンカー) は対象外 = `density=null` で、ADR-0004「未アンカーは valid のまま」を維持。

### 6.3. 検証成功判定

- `verifyProofFile` 全レイヤを `&&` で組み合わせる
- 署名済み checkpoint は `anchored=true` のとき必須レイヤ。`anchored=false` (旧 proof など) では他レイヤで成立すれば valid
- **アンカー密度 (ADR-0016)** は既定 warning。`requireAnchorDensity` (verify-cli の `--require-anchor-density` 等) を渡したときのみ `sparse` を signed checkpoint レイヤの fail に合流させる (exam/採点で opt-in)
- **root サーバアンカー (ADR-0017)**: `sessionStartToken` があるとき token↔署名 cp の `sessionId` 一致も要求する (アンカーとチェーンの結びつき)。`rootAnchored=false` (token 無し = オフライン劣化 / 旧 proof) は既定 warning。`requireRootAnchor` (verify-cli の `--require-root-anchor`) を渡したときのみ fail に合流させる (exam は独自束縛のため対象外。high-stakes 採点で opt-in)
- レイヤ間優先順位: metadata → chain → finalHash → checkpoint → content → signedCheckpoint
- いずれかが false なら、エラー位置 (event index) とメッセージを返す

### 6.4. 試験束縛検証 (grader, ADR-0006)

試験モード proof には上記 6 レイヤに加え `verifyExamBinding` がある。**完全オフライン**で動く。root 束縛 (上記 Layer 1 の exam 分岐) は proof 自己完結なので package 不要だが、**真正性 (本物の問題か) と内容束縛は問題パッケージ (`.tcexam`) を grader に渡したときのみ**検証できる。

1. package 署名を `examAuthorityKeys` で検証 → 本物の問題。**信頼は registry 登録鍵に限る** (未登録 keyId は同梱公開鍵があっても untrusted = 自己署名を排除)。鍵の有効期間/失効も `releaseTime` を anchor に判定 (validFrom 前・validUntil 後・失効後 release は reject、失効前 release は warning 付き trust)。anchor が出題者自己申告な点の限界は [ADR-0006 セキュリティ硬化](adr/0006-exam-mode-sealed-problem-binding.md) 参照
2. `packageHash` 再計算 = `proof.exam.packageHash` → この問題に束縛
3. root 再計算 (`fingerprintHash, nonce, packageHash, proof.exam.startToken`) = `initialEventChainHash` → **T0 以降に開始** (token は proof 同梱なので out-of-band 不要)
4. `startToken` で package を復号 → 平文 `problemContentHash` = `proof.exam.problemContentHash` → 答案はこの問題のもの
5. **time-box** (advisory): `releaseTime ≤ 提出時刻 ≤ deadline`。実際の提出時刻は外部 (Moodle)。verify-cli は `--submitted-at` で渡せ、未指定なら window 表示のみ (`withinWindow=null`)

配線: **verify-cli** は `--exam-package <file.tcexam>` で渡す (任意、未指定なら root 束縛のみ表示し「package 未提供」を明示)。**verify(web)** は試験束縛カードで root 束縛を常時表示し、「問題パッケージを読み込む」で `.tcexam` を取り込み当該タブを再検証して完全束縛を表示する。package 指定で束縛が失敗すれば全体を invalid とする。

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
| **(試験)** T0 前に問題を読んで事前 solve | 封印 (Argon2id + 監督コード)。T0 まで復号不可 (消費期限つき; 配布窓は数分) |
| **(試験)** 配布と異なる別問題の解答にすり替え | §6.4 (packageHash 不一致 / 復号後 problemContentHash 不一致) |
| **(試験)** T0 より前に開始したのに後に見せかける | §6.4 (root に `startToken` が焼かれる。T0 前は監督コードを知り得ないため root を作れない) |
| **(試験)** 過去回 / 他人の試験 proof を流用 | Layer 1 (fingerprint/nonce 不一致) + §6.4 (packageHash 不一致) |
| **(試験)** 出題者を詐称した偽問題パッケージ | §6.4 (`examAuthorityKeys` での署名検証に失敗) |

**多層性 (defense in depth)**: 一つのレイヤを攻撃者が突破しても、他レイヤが直交的に検出する。たとえば event の data 改ざんは Layer 2 の hash 不一致と Layer 4 の content 不一致と Layer 6 の chainHash 不一致の **3 経路で検出される**。

---

## 8. 信頼保証と限界 (重要)

### 8.1. 強い保証 (Cryptographic Guarantees)

以下は SHA-256/ECDSA-P256 の安全性が破られない限り **数学的に保証**される。

- **改ざん検出**: 過去に発行された proof の任意 1 ビットの改ざんは、Layer 2/4/6 のいずれかで決定的に検出される
- **流用検出**: 別の fingerprint / sessionId / initialEventChainHash 由来のデータ流用は決定的に検出される
- **時刻アンカリング (signed checkpoints 利用時)**: 各 envelope の `serverTimestamp` は「サーバが署名要求を受け取った時刻」を証明する → proof は最古の `serverTimestamp` 以降に存在していたことが証明される
- **長期検証可能性**: 公開鍵 registry が git で永続管理され verify-cli にバンドルされる → Cloudflare Workers が停止しても永続的に検証可能。**信頼アンカーは常に registry**。envelope 同梱の公開鍵は registry 一致の cross-check 用であって信頼の源ではない (未登録 keyId は埋め込み鍵があっても拒否)
- **(試験モード) 問題・T0 束縛**: `proof.exam` のある proof は、答案チェーンの root が「配布された問題 (`packageHash`) + 監督コード (`startToken`)」に焼かれている。出題者署名が破られない限り、別問題すり替え・T0 前開始・偽問題は §6.4 で決定的に検出される (root 束縛は package 無しでも検証可能)

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
- **(試験モード) 窓内・同一マシンの忠実な転写**: T0 以降に正規エディタで AI 出力を手で書き写す等は proof として valid になる。封印は「T0 までの数分」を守るだけで永続金庫ではない (短コードゆえ「絶対割れない」とは喧伝しない)。本人性も TypedCode は担わない (Moodle)。これらの残差は **proctor (唯一の真の air gap) + 後段の挙動分析** (別 ADR、pluggable) が担う

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
3. **デプロイ**: `npm run deploy:production -w @typedcode/workers` (staging は `deploy:staging`。通常は CI 経由。`deploy` 単体は誤実行防止でエラー終了する)

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
| **event** | エディタ操作 1 つを表す最小単位。29 種類 |
| **chain hash** | event.hash。previousHash + eventData の SHA-256 |
| **PoSW** | Proof of Sequential Work。10000 回 SHA-256 反復 |
| **checkpoint** | 直前 cp から 100 event か 10 秒のいずれかが先に到達した時点で作られる「中間スナップショット」 |
| **signed checkpoint** | サーバが ECDSA-P256 で署名した checkpoint。temporal anchoring の本体 |
| **envelope** | SignedCheckpointEnvelope。署名済み payload + 署名 + keyId |
| **firstSeenAt** | サーバが initial に sessionId を見た時刻。KV 由来で不変 |
| **anchored** | proof に signed checkpoint が 1 つ以上含まれている状態 |
| **post-hoc batch signing** | proof 完成後に複数 envelope を短時間で一括取得する攻撃。temporal ratio で検出試行 |
| **anchor density / sparse (ADR-0016)** | 署名 cp が主張イベント数/時間に対し十分密かを見る指標。`maxGapEvents>500` / `maxGapServerMs>50s` / `firstAnchorLatencyEvents>500` で `sparse`。末尾 1 点アンカー (coverageRatio=1.0 でも疎) を検出。既定 warning、`requireAnchorDensity` で strict-fail |
| **session start token / serverNonce (ADR-0017)** | session/start が Turnstile 後に発行する ECDSA 署名トークン。`serverNonce` を root (`SHA256(fp ‖ localNonce ‖ serverNonce)`) に焼き、開始時刻をサーバアンカーする。完全オフライン捏造を封じる。Turnstile ゲート + root アンカー + 人間ゲートを兼ね、HMAC attestation の作成経路を置換 |
| **rootAnchored (ADR-0017)** | proof の root が serverNonce トークンでアンカーされているか。`sessionStartToken` 同梱で true。false (旧 proof / オフライン劣化) は warning、`requireRootAnchor` で strict-fail。exam は対象外 |
| **isTrusted / 合成打鍵 (ADR-0018)** | keyDown/keyUp の `data.isTrusted===false` = JS dispatch (拡張/ページスクリプト) の合成打鍵。keystroke data 経由で hash chain に焼かれ改ざん耐性あり。`automationAnalyzer` が数えて advisory signal。**限界**: CDP/ハード注入は isTrusted=true で捕捉不可 (部分的) |
| **(試験) 試験モード** | URL パス `/exam` で入る anti-AI-cheating モード (ADR-0011 でモードを path 分岐化、旧 `?exam=1` sticky を置換)。封印問題 + 監督コード + チェーン根束縛。ADR-0006〜0011 |
| **モード (casual/class/assignment/exam)** | URL パスで確定する動作モード (ADR-0011/0015)。`/casual` `/class` `/assignment` `/exam`。能力 (スクショ/封印/フルスクリーン等) と storage 名前空間がモード別。proof に自己申告 `mode` を記録 |
| **ランディング / `/`** | ルート `/` と未知パスはモード選択の入口 (ADR-0015)。4モードを**比較カード**で横並びに見せ能力差を一覧化、`/<mode>` へ遷移。エディタは初期化せず DOM のみ描画。進行中セッションは「続きから (N)」バッジで表示 (`SessionDetector`、空 DB を作らない read-only 検出)。タイポ (`/exsm` 等) を黙って casual にせず入口へ落とす |
| **(練習) 練習モード / `/casual`** | 素のエディタ・お試し/個人・最低保証 (ADR-0015。表示名「練習/Demo」、内部 id/ルートは `casual`)。利用規約モーダルなし (同意は入口で一度)・画面共有は既定オフでバナーからオプトイン。Turnstile `#0` は維持。proof 整合は不変 |
| **モード切替ピル** | エディタ titlebar の現モード表示+ドロップダウン (ADR-0015、`ModeSwitcher`)。別モード選択で `/<mode>` へ遷移。storage がモード別名前空間なので現モードの作業は保持される |
| **(授業) 授業モード / `.tcclass`** | URL パス `/class` で入る封印なしモード (ADR-0014)。平文問題ファイル `.tcclass` (`{schema:'tcclass/1', classId, allowed, bundle}`、暗号・署名なし) を読み込み問題表示 + N タブ展開。tier ① 自己申告 (root 束縛なし)。fullscreen は受動記録 (要求バナーなし) |
| **(試験) 封印問題パッケージ / `.tcexam`** | 出題者が Argon2id + AES-256-GCM で封印し ECDSA-P256 署名した問題ファイル。Moodle で事前配布 |
| **(試験) 監督コード / `startToken`** | T0 に監督が解禁する 8 文字 Crockford Base32 (40bit)。封印を解錠しチェーン根に焼かれる |
| **(試験) packageHash** | manifest の canonical core (− `{signature, publicKeyJwk}`) の SHA-256。root と `proof.exam` に束縛 |
| **(試験) 出題者鍵 / `examAuthorityKeys`** | 問題パッケージ署名鍵のレジストリ。cp 署名鍵 (`checkpointKeys`) と別系統・同型 |
| **(試験) genesis** | 試験モードでチェーン根を確定する瞬間 = 監督コード入力 = T0 |

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
| `PROOF_FORMAT_VERSION` | '1.1.0' | `version.ts` (1.1.0 = 試験モードの root 式対応。casual proof も 1.1.0 を刻むが構造は不変) |
| `STORAGE_FORMAT_VERSION` | 1 | `version.ts` |
| `MIN_SUPPORTED_VERSION` | '1.0.0' | `version.ts` (旧 proof も検証可) |
| `EXAM_PACKAGE_FORMAT_VERSION` | 1 | `version.ts` (`.tcexam` の formatVersion) |
| `EXAM_PROOF_VERSION` | 1 | `version.ts` (`proof.exam.examProofVersion`) |
| `EXAM_ROOT_BINDING` | 'v1' | `version.ts` (単一問題, ADR-0006) |
| `EXAM_ROOT_BINDING_V2` | 'v2' | `version.ts` (N問バンドル, root に problemContentHash を連結, ADR-0012)。現行 editor は新規 exam を v2 で焼く |
| Argon2id params (試験) | memKiB=65536 / iterations=3 / parallelism=1 | `make-exam-package.mjs` 既定 (manifest に保持し出題者が調整可) |
| 監督コード | 8 文字 Crockford Base32 (`I L O U` 除外, 40 bit) | ADR-0006 |

注: `CheckpointManager.CHECKPOINT_INTERVAL` は `DEFAULT_MAX_EVENTS_PER_CHECKPOINT` の値を持つ deprecated エイリアスとして維持される。

---

## 11. 関連ドキュメント

- [packages/workers/README.md](../packages/workers/README.md) — Workers のセットアップとデプロイ手順
- [packages/shared/README.md](../packages/shared/README.md) — shared API リファレンス
- [packages/verify/README.md](../packages/verify/README.md) — 検証 UI の使い方
- [packages/verify-cli/README.md](../packages/verify-cli/README.md) — CLI 検証ツール
- [CLAUDE.md](../CLAUDE.md) — リポジトリ全体の玄関口 (Claude Code / Agent SDK 用)
- [packages/*/CLAUDE.md](../packages/) — 各サブシステムの責務 / 不変条件 / 罠
- [docs/adr/](adr/) — Architecture Decision Records (なぜそうしたかの蓄積)
- 試験モード ADR: [0006](adr/0006-exam-mode-sealed-problem-binding.md) (封印問題 + 根束縛) / [0007](adr/0007-maximal-signal-capture.md) (生信号捕捉) / [0008](adr/0008-exam-fullscreen-request-not-enforce.md) (フルスクリーン要求) / [0009](adr/0009-pluggable-analysis-layer.md) (分析層) / [0010](adr/0010-exam-session-model.md) (セッションモデル, ADR-0011 で sticky を置換) / [0011](adr/0011-course-modes-and-path-routing.md) (授業/課題/試験のモードと path 分岐)

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
| 2026-06-07 | 試験モード (ADR-0006, PR1–4) | 封印問題パッケージ (`.tcexam`, Argon2id + AES-256-GCM + ECDSA-P256) + 監督コードによるチェーン根束縛。`PROOF_FORMAT_VERSION` 1.0.0→1.1.0、`proof.exam` ブロック、`examOpened` イベント、`examAuthorityKeys` レジストリ、`verifyExamBinding` を verify-cli / verify(web) に配線。本仕様に「試験モード」(§4.7) + 検証 (§6.4) を反映 |
| 2026-06-09 | 授業モード (ADR-0014) | 平文 `.tcclass` (`tcclass/1`、暗号・署名なし) で問題を配布し `/class` で表示 + N タブ展開 (tier ① 自己申告、root 束縛なし)。受動的 fullscreen 記録 (要求バナーなし)。`/author` に未封印 `.tcclass` 生成を追加。proof 互換 (`PROOF_FORMAT_VERSION` 据え置き)。本仕様に「授業モード」(§4.8) を反映 |
| 2026-06-09 | 導線整理 (ADR-0015) | ルート `/` をモード選択ランディングに (`/casual` を明示ルート化、未知パスも入口へ → 黙 casual 事故を解消)。**4モードの比較カード** + 進行中セッションバッジ (`SessionDetector`) + **エディタ内モード切替ピル** (`ModeSwitcher`)。casual は利用規約モーダルなし + 画面共有オプトイン (既定オフ)、Turnstile `#0` 維持、表示名を「練習/Demo」に (id/ルートは不変)。`resolveRoute` / 能力 `promptScreenShareAtStart` を追加。proof 整合は不変 |
| 2026-06-12 | アンカー密度 (ADR-0016, Phase 7-B) | 署名 cp の **アンカー密度**を検証器のメトリクス化 (`SignedCheckpointsVerificationResult.density`)。`maxGapEvents` / `maxGapServerMs` / `firstAnchorLatency*` を計量し、保守的閾値 (cadence×5) 超で `sparse`。末尾 1 点アンカー (coverageRatio=1.0 でも偽造可) を検出。既定 warning、verify-cli `--require-anchor-density` で strict-fail。**非破壊** (proof フォーマット不変)。§6.2/§6.3/§10 を反映 |
| 2026-06-12 | root サーバアンカー (ADR-0017, Phase 7-A) | **`PROOF_FORMAT_VERSION` 1.1.0→1.2.0** (MIN_SUPPORTED 1.0.0 据置・後方互換)。session/start (Turnstile→ECDSA トークン) で casual/class の root を `SHA256(fp ‖ localNonce ‖ serverNonce)` にサーバアンカーし、完全オフライン捏造を封じる。proof に `sessionStartToken` + `rootAnchored` を加算。検証器は registry-only でトークン検証→serverNonce 込み root 再計算→token↔cp sessionId 突合。フォールバック (b): 不達なら `rootAnchored:false` で継続 (warning)。`requireRootAnchor` で strict-fail (exam 除外)。HMAC attestation の作成経路を session/start に統合。§4/§6.2/§6.3/§10 を反映 |
| 2026-06-12 | isTrusted 捕捉 (ADR-0018, Phase 7-C) | keyDown/keyUp の `KeystrokeDynamicsData.isTrusted` に**合成打鍵 (`!e.isTrusted`) のときだけ** `false` を載せる (keystroke data 経由で hash 済・**加算的**・honest 打鍵はバイト一致で hash 不変)。`automationAnalyzer` が untrusted 打鍵数を数えて advisory signal。**限界**: CDP/ハード注入は isTrusted=true で捕捉不可 (部分的)。§10 を反映 |
| 2026-06-12 | editor-assist 宣言 (ADR-0019, Phase 8-W0) | `environmentProbe` に **`editorAssist` 宣言** (`editor-assist/1`) を加算的に追加。Monaco の**解決済み**支援オプション (quickSuggestions / inlineSuggest / snippet / 括弧自動閉じ 等 13 項目) を起動時に正規化して焼き、「どの支援が有効な環境での記録か」をセッション間で比較可能にする。記録のみでポリシー判断はしない (別 ADR)。取得不可は null (graceful absence)。proof フォーマット非破壊・新イベント型なし。§4.1 を反映 |
| 2026-06-12 | 分析層の配線 (ADR-0009, Phase 8-W1) | shared の分析フレームワーク (`runAnalysis`) を **verify(web) と verify-cli の両方に配線**。verify は verificationWorker が検証後に実行し `AnalysisReportCard` で表示、**evidence (event index) クリックでシークバーの当該イベントへジャンプ**。CLI は evidence 表示 + `--analysis-json` (評価ハーネスの機械可読入口) を追加。すべて advisory で valid / exit code には不反映 (直交性維持)。proof フォーマット不変 |
| 2026-06-12 | 三層保証語彙 (ADR-0020, Phase 8-W2) | 保証を **整合性 (proven/failed) × 時刻アンカー (anchored/partial/unanchored/exam-t0) × 著述性 (常に advisory)** の三層として shared `deriveAssurance` で**実証拠のみから機械導出** (自己申告 `mode` 不使用 = ADR-0011 §6 消化)。verify は結果最上部にバッジ列 (+ mode 参考表示)、CLI は `--- Assurance ---` を出力。§1 の主張文言を三層に精密化 (overclaim 是正)。判定 (`verifyProofFile` の valid) は不変・proof フォーマット不変 |
| 2026-06-12 | プロセス要約 (Phase 8-W3 A/B) | shared `summarizeProcess` がイベント列から制作過程の**中立な要約** (挿入/削除・実行・編集停止・focus 喪失・外部入力 + 見どころの event index) を決定的に抽出。verify は `ProcessSummaryCard` (見どころ→シークバージャンプ)、CLI は `--- Process summary ---`。**再生強化 (W3-C)**: シークバーに再生モード (= 等間隔 / ×1 ×10 ×60 実時間比例) と**見どころマーカー** (moments をトラック上に色分け表示・クリックでシーク) を追加。中立な記述であって疑い指標ではない (疑いは ADR-0009 分析層)。proof 非焼込・フォーマット不変 |
| 2026-06-12 | 実行結果の捕捉 (ADR-0021) | `codeExecution` を **start / result の 2 イベント**に拡張 (新イベント型なし・加算的・旧 proof 互換)。result の outcome/exitCode/elapsedMs から `summarizeProcess` が **初の失敗実行 / 失敗からの初成功** (デバッグサイクル) を見どころ抽出。出力テキストは記録しない。§4.1 を反映 |
| 2026-06-12 | セルフレビュー (ADR-0022, Phase 8-W4A) | export 直前に**提出前セルフレビュー** (自分の ProcessSummary = 採点者と同じ要約 + 任意の振り返り)。ノートは新イベント型 **`reflectionNote`** としてチェーンに焼かれ改ざん検出つき。能力 `selfReview` (casual/class/assignment=on, **exam=off**)。検証経路は未知イベント型を拒否しないことを確認済みで `PROOF_FORMAT_VERSION` 1.2.0 据え置き。verify 要約カード/CLI に「本人の振り返り」を表示。§4.1 を反映 |
| 2026-06-12 | 分析器の実証評価 (ADR-0009, Phase 8-W5) | アナライザを `severity: 'review'` に昇格してよいかを**ラベル付きコーパスの実測で判断する評価ハーネス**。shared 純粋関数 `evaluateAnalysis` (`analysis/eval.ts`) が overall + 各 dimension の混同行列・閾値スイープ (precision/recall/F1/**FPR**)・FPR 上限下の推奨閾値、および headline の **genuineSignalRate** (本物が誤って signal を出す率) を算出。`analysisEvalCorpus.test.ts` が合成ラベル付きコーパス生成 (`GEN_FIXTURES=1`) と実データ評価 (`EVAL_CORPUS=<dir>`) を提供。**運用ゲート: 実測で FPR が許容内と示されるまで heuristic アナライザ (transcription-topology / focus-burst) を `review` に昇格させない** (現状 notice 据え置き)。収集プロトコル・同意・昇格基準は docs/analysis-eval-protocol.md。proof フォーマット不変・分析は advisory のまま (直交性維持) |
| 2026-06-12 | 分析プラットフォーム方針 (ADR-0023) | **TypedCode は判定器ではない**ことを明文化: 我々はデータ収集も閾値の焼き込みもせず、採点者/研究者が**自分のデータと自分の分析器**で判断できる**基盤**を提供 (ADR-0009/0020 の advisory 原則を製品方針へ昇華)。`Analyzer` 契約 (`AnalysisInput`=検証済み proof 全イベント列+fingerprint+`FullVerificationResult` / 返り `AnalysisSignal[]`) を**安定 public API** と位置づけ。verify-cli に **`--analyzer <module>` (反復可) / `--no-default-analyzers`** を追加し外部 ES モジュールの Analyzer を `runAnalysis` に差込み可能に (読込 I/O は CLI・分析ロジックは外部、`loadExternalAnalyzers` が契約検証+重複id拒否)。既定分析器は advisory プレースホルダ据え置き。W5 ハーネス/プロトコルを「各自がデータで検証する道具」に再フレーム。advisory のまま exit code 非干渉・proof フォーマット不変 |
| 2026-06-12 | データ最小化ティア (ADR-0024, 設計のみ) | 整合性検証は**全イベント必須** (チェーンが全打鍵を束ね redact 不可) だが、その全イベント列はソース全文・打鍵動態・fingerprint を含む。最小化は **proof の改変ではなく目的別の派生ティア**で行うと確定: **Tier F** (full proof = 全イベント+content+fingerprint、整合性検証/ソース採点/完全リプレイ、信頼された相手のみ) / **Tier A** (content-free = `ProcessSummary`+`AnalysisReport`+`AssuranceResult`、分析/研究/コホート) / **Tier S** (集計サマリ)。不変条件: 最小化は整合性アーティファクトを弱めない・同梱分析はソース平文なしで導出可能 (ソース依存分析は採点者 private)・fingerprint は Tier F 限定・派生ビューは単独で整合性検証不能と明記 (overclaim 防止)。検証可能な選択的開示 (content コミットメント) は将来 ADR。実装 (Tier A エクスポート) は follow-up。コード変更なし |
| 2026-06-12 | コホート基準 (ADR-0025, 設計のみ) | 1 件の過程要約は単独で読めない (「45分は速い?」はコホート分布に対してしか意味を持たない) → 採点者向けに **content-free なコホート基準**を定義。**我々は norms を配らない** (ADR-0023): 採点者が自分の Tier A 群 (ADR-0024) から計算する。Baseline = メトリクスごとの頑健統計 (中央値/IQR/n) + 各分析次元の base rate、**個票は保持しない**。Position = 提出物が各分布のどこか (percentile/IQR位置) を **advisory な triage** で提示。不変条件: **外れ値 ≠ 違反** (valid/exit code 非反映)・content-free で集約のみ (コホート内プライバシー)・記述的であって規範でない (IME/支援技術/速度の多様性は正当な外れ値・★6b と併読)・頑健統計+小N ガード+代表性の明示 (overclaim 防止)。実装 (`computeCohortBaseline`/`positionInCohort` 純関数・表示) は follow-up。コード変更なし |
| 2026-06-12 | 支援技術・IME 配慮ポリシー (★6b, docs のみ) | 分析・コホート基準が IME/支援技術の利用者を不当に不利にしないための運用方針 (`docs/accessibility-accommodation-policy.md`)。決定: ①支援技術/IME を自動的に不利に扱わない ②障害情報を収集しない・AT を自動検出して疑わない (配慮は教員が TypedCode 外で手配) ③捕捉層の実挙動を正直に開示。**正直な開示**: IME 合成 (`insertCompositionText` 等) は許可リストで `isPureTyping` を false にしない (リスクは分析層のみ)。一方 **`insertReplacementText` は禁止リストにあり、ディクテーション/自動修正/単語予測がこれを使うと `isPureTyping=false` になりうる** → `isPureTyping=false` はペースト不正とは限らず支援入力でもありえ、捕捉層は区別不能 (原理的曖昧性・検出で塞げない)。よって機械的にクロと読ませない。既知の偽陽性モード早見表 + 試験モードとの緊張 (運用で配慮手配) + 非目標 (`insertReplacementText` を AT 理由で緩めない = ペースト回避の穴)。ADR-0005/0009/0023/0025 と相互参照。コード変更なし |
| 2026-06-12 | Tier A エクスポート (ADR-0024 実装) | shared に **content-free な Tier A バンドル** `AnalysisBundle` (`analysis-bundle/1`) + `buildAnalysisBundle` を追加。`{ integrityValid, processSummary, analysis, assurance }` のみで **events / ソース / fingerprint を含まない** 派生ビュー。verify-cli `--analysis-bundle <out.json>` で全 proof 分を `{filename, ...bundle}` として出力 (コホート基準 ADR-0025 の入力フォーマット)。組み立ては shared 委譲・CLI は content-free な派生物を渡すだけ。バンドルは単独で整合性検証できない (Tier F で別途) ことを `integrityValid` の意味として明記。advisory・exit code 非干渉・proof フォーマット不変 |
| 2026-06-12 | コホート基準の実装 (ADR-0025 実装) | shared 純粋関数 `computeCohortBaseline(bundles)` / `positionInCohort(bundle, baseline)`。Tier A `AnalysisBundle[]` を入力に、メトリクス (durationMs/deletionRatio/pauseCount/reviewPriority 等 13 種) ごとの**頑健分布** (中央値/IQR/min/max/n) + 各次元の base rate (notable signal を出したバンドル割合) を算出。`CohortBaseline` は**集約のみ・個票非保持** (コホート内プライバシー)。`positionInCohort` は提出物の midrank percentile + IQR 単位の箱外距離を返す (五数要約からの近似 = 個票非保持の代償と明記)。`COHORT_MIN_N`=5 未満は `sufficient:false` で警告 (小N ガード)。**すべて advisory な triage で外れ値≠違反・valid/exit code 非干渉**。表示/CLI 面は follow-up。proof フォーマット不変 |
