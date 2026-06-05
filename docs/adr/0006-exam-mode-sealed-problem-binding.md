# ADR-0006: 試験モードは封印問題パッケージで proof を試験にバインドする

- **Status**: Proposed
- **Date**: 2026-06-05
- **Deciders**: (PR 上の合意者 / レビュアー)
- **PR / Commit**: (this PR)

> このドラフトは設計合意の記録であり、**実装は後続 PR で行う**。proof フォーマットとハッシュ根に焼き込まれる不可逆な決定 (= 後から録り直せない) のため、実装前に確定させる。

## Context

TypedCode を **大学の試験**（生成 AI / 自動入力ツールの不正利用を防ぐ）で使う。運用前提と制約:

- **ローカル完結**: 学生はローカルで解答し、ログ + コードを **Moodle に提出**する。この形を崩さない。
- **サーバは最小・best-effort のみ**: Turnstile と時刻アンカー程度。**会場のネットは不安定**で、100 名同時受験時にサーバ不具合で全員が受験不能になる事態を避ける = **サーバを critical path に置かない**。
- **個人/端末の識別・アカウント認証は一切やらない**。本人性は Moodle 提出が外側で担う。
- 問題は **Moodle で配布**（試験少し前、着席・監督下）。早期漏洩は脅威に含めない。

不正検出には2つの直交する問題があり、本 ADR は後者の **土台**を定める:

1. **改ざん耐性** — 既存のハッシュチェーン + PoSW + 署名 cp で達成済み (ADR-0002)。
2. **不正ツール検出** — クライアントは半信頼 (公開コード・攻撃者の手元で動く) ため**原理的に確率的**。クライアント単体で「同一マシン・試験時間内の AI 利用」を物理的に防ぐことは不可能。

正直な再定義: **TypedCode = 改ざん耐性のある答案 + 記録するペン / 試験監督 = air gap の担い手 / Moodle = 本人性**。この三者分業で実質「紙の試験」に近づける。ツールが構造的に潰すべきは **事前 solve・使い回し・別問題すり替え・提出後改ざん**。残差 (窓内・同一マシンの忠実な転写) は **proctor + 後段の挙動分析** が担う (後者は意図的に未実装、本 ADR の対象外、別 ADR 予定)。

本 ADR が決めるのは: **「解答が、配布された"その問題"に、"試験開始 (T0) 以降"に紐づく」ことを、ライブサーバ依存ゼロ・匿名で proof に焼き込む方法**。

## Considered Options

### 問題の配布形式

#### Option A: 試験中にライブ URL から取得
- Pros: 配布が動的・更新容易。
- Cons: **T0 に 100 名が不安定ネットでサーバを叩く** = 避けたい「全員受験不能」を最悪のタイミングで critical path に戻す。**却下**。

#### Option B: 署名済み・自己完結の問題パッケージ（ファイル）を事前 DL → ローカル取り込み（採用）
- Pros: 一度落とせばオフライン完結。落とすタイミングに幅があり herd が緩む。Moodle 配布と対称。サーバ障害が受験を止めない。
- Cons: 平文だと事前に中身が読める。→ 下記「封印」で解決。

### 問題の封印（T0 まで読めなくする）

#### Option C: 平文配布 + TypedCode 側で UI マスク
- Pros: 最軽量。
- Cons: 落としたファイルを直接覗けば読める = **実質的な封印にならない**。**却下**。

#### Option D: 監督コード（passphrase）で復号する暗号化（採用）
- 暗号文を事前配布し、T0 に監督が短いコードを口頭/板書で解禁。コードで復号。
- **暗号工学上の現実**: 短いコード + 事前配布の暗号文 → オフライン総当たりで早期復号され得る。封印強度 = (コードのエントロピー × KDF の遅さ) 対 (攻撃者が T0 前に暗号文を持てる時間)。本運用ではその時間は **数分**（着席後配布）。
- → **遅い KDF (Argon2id) + 中エントロピーのコード**で「**T0 までの数分だけ確実に持つ消費期限つき封印**」にする。永続金庫ではないが試験には必要十分。
- Pros: 本物の暗号封印。T0 に必要なのは短いコードのみ = **100 名同時でもサーバゼロ**。落とした後オフライン。
- Cons: 「絶対割れない」ではない (短コードゆえ)。Argon2 の wasm 依存。

#### Option D-strict: T0 にプロジェクタで QR(256bit 鍵)提示
- Pros: 総当たり不能。
- Cons: UX 重い (スキャン/長文字列)。strict オプションとして将来検討。**今回不採用**。

### KDF: Argon2id vs PBKDF2-SHA256
- **Argon2id 採用**。メモリハードで GPU 並列耐性。PBKDF2 はネイティブだが GPU に弱く、短い窓でも余裕が小さい。

### 時刻アンカー: 連続サーバ heartbeat vs 問題ノンス根 + Moodle 提出
- 連続 heartbeat は**サーバ依存**で却下。time-box は **下限 = 問題パッケージ + 監督コードをチェーン根に束縛 / 上限 = Moodle 提出時刻 / 補強 = best-effort 署名アンカー** の3層とし、サーバ全断でも (下限+上限) で成立させる。

### 主催者署名鍵のレジストリ: 別系統 vs 統合
- **別系統 `examAuthorityKeys` を採用**。用途 (問題署名) が cp 署名と異なり、主体・失効・ローテーションが別。構造は `checkpointKeys` と同型にして検証ヘルパを共有 (ADR-0002 のパターン流用)。

### 監督コードの文字数: 短さ vs 強度
- **8 文字・Crockford Base32 (`I L O U` 除外, 32種=5bit/字) = 40 bit を採用**。封印が破られなければよいのは T0 前の数分のみ。8 文字なら極端な攻撃者 (10⁸ H/s) でも平均解読 ~1.5 時間で窓を桁違いに上回る。6 文字 (30bit) は現実的攻撃者 (10⁶ H/s) で ~9 分=配布窓と被るため**非推奨**。余分な 1–2 文字で margin を買う方が、Argon2 を過激にチューニングして 6 文字を守るより堅牢 (攻撃者ハード性能への依存が減る)。チェックサムは付けない (誤入力は GCM 認証タグが確実に弾く)。

### proof への token 保存: 保存 vs grader 再計算 (out-of-band)
- **proof に保存する**。token は T0 後に公開値なので保存してもセキュリティ損失ゼロ (束縛の価値は「T0 前に知り得ない」点で、保存とは独立)。保存すると **grader は提出物だけで self-contained に検証でき**、出題者の控えからコードを out-of-band に渡す運用が不要になり、コード紛失で root 検証不能になるリスクも消える。

### per-student variant
- **schema にフィールド (`problemId` / `variant`) を予約して前方互換にし、v1 運用は単一問題 (`variant=null`)**。フォーマットは後から変えられないので capability は今入れ、運用有効化は後で (フォーマット bump 不要)。

## Decision

**「試験モード」を新設し、Moodle で配る署名済み・Argon2id 暗号化の問題パッケージを、監督コードで開封すると同時にタイピングチェーンの根へバインドする。**

### 1. Exam Package (`*.tcexam`, JSON) — 平文メタ + 暗号化問題 + 署名

```jsonc
{
  "formatVersion": 1,
  "examId": "2026-spring-cs101-final",
  "problemId": "p1",
  "variant": null,
  "kdf":    { "algorithm": "argon2id", "salt": "<hex16B>",
              "params": { "memKiB": 65536, "iterations": 3, "parallelism": 1 } },
  "cipher": { "algorithm": "AES-256-GCM", "iv": "<hex12B>", "ciphertext": "<base64>" },
  "releaseTime": "<ISO T0>",
  "deadline":    "<ISO T1>",
  "allowed": { "languages": ["c", "python"] },
  "keyId": "exam-2026s-ab12cd",
  "algorithm": "ECDSA-P256",
  "publicKeyJwk": { /* 任意同梱 */ },
  "signature": "<hex ECDSA-P256>"
}
```

- **監督コード (`startToken`) = 8 文字・Crockford Base32 (`I L O U` 除外) = 40 bit**。CSPRNG 生成、スライド表示用にグルーピング (例 `ABCD-EFGH`)。チェックサムなし。
- コードの正しさは **AES-GCM 認証タグ**で判定 (誤コード→復号失敗)。**平文 manifest に token のコミットメント (`H(token)`) は置かない** (低エントロピーゆえ総当たりで漏れるため)。
- `signature` = `ECDSA_P256.sign(privKey, deterministicStringify(manifest 除く {signature, publicKeyJwk}))`。暗号文を含む全体にかかる。

### 2. 主催者鍵レジストリ `examAuthorityKeys/registry.ts` (append-only)

```ts
interface ExamAuthorityKey {
  keyId: string; publicKeyJwk: JsonWebKey;     // ECDSA P-256
  status: 'active' | 'revoked';
  validFrom: string; validUntil?: string; revokedAt?: string;
  description: string;
}
```

### 3. チェーン根への束縛 (exam モード, version-gated)

```
packageHash           = SHA256(deterministicStringify(manifest))
initialEventChainHash = SHA256(fingerprintHash ‖ localNonce ‖ packageHash ‖ startToken)
```

- **genesis は監督コード入力の瞬間 (= T0)**。root が `startToken` を含むため、root はコード入力まで計算できず、セッション初期化ではなく**コード入力時に genesis を確定**する (exam モードの実装分岐)。それまで問題はマスク (復号不可)。
- **`#0 = humanAttestation` の不変条件は保持** (Turnstile は T0 前に取得・root 確定後に #0 として記録、best-effort)。**`examOpened` イベント (`{examId, problemId, packageHash, problemContentHash, openedAt}`) は #1** として記録 — 権威ある束縛は root + `proof.exam`、examOpened はタイムライン上の可読な監査印。
- **`startToken` は `proof.exam` に保存する** (self-contained 検証、上記 Considered Options 参照)。

### 4. proof の `exam` ブロック (exam モード時のみ)

```jsonc
"exam": {
  "examProofVersion": 1,
  "examId": "...", "problemId": "p1", "variant": null,
  "packageHash": "<hex>",
  "problemContentHash": "<hex>",   // 復号後**平文**の SHA-256 (事前公開しない)
  "startToken": "<監督コード>",    // T0 後は公開値。self-contained 検証用に保存
  "rootBinding": "v1"
}
```

### 5. grader (verify-cli, 完全オフライン) 検証フロー

1. package 署名を `examAuthorityKeys` で検証 → 本物の問題
2. `packageHash` 再計算 = `proof.exam.packageHash` → この問題に束縛
3. root 再計算 (fingerprintHash, localNonce, packageHash, **`proof.exam.startToken`**) = `initialEventChainHash` → **T0 以降に開始** (token は proof 同梱なので out-of-band 不要・self-contained)
4. `startToken` で package を復号 → 平文 `problemContentHash` = `proof.exam.problemContentHash` → 答案はこの問題のもの
5. 既存のチェーン/PoSW/署名 cp 検証
6. time-box: T0(package) ≤ 作業 ≤ Moodle 提出
7. (後段・pluggable) 転写/挙動分析

### 6. バージョニング

`Exam Package.formatVersion` / `proof.exam.examProofVersion` / `rootBinding` を独立管理。root 式が変わるため **`PROOF_FORMAT_VERSION` を bump**。non-exam proof は従来式据え置き。新フィールドは加算的 (旧 verifier は未知フィールド無視)。

## Consequences

### Positive

- **T0 にライブサーバ依存ゼロ** = ネット不安定・100 名同時でも受験が止まらない (絶対条件を満たす)。
- **匿名** = 端末識別・アカウント認証なし。本人性は Moodle が担う。
- **構造的に閉じる**: 事前 solve・過去回再利用・別問題すり替え・提出後改ざん。
- **オフライン・self-contained 検証**: `startToken` を proof に同梱するため、grader は提出物 (+ 公開 package) だけでネットも out-of-band の控えも不要に検証できる。
- **既存資産流用**: ECDSA-P256 / `deterministicStringify` / append-only 鍵レジストリ (ADR-0002) をそのまま使う。新規暗号プリミティブは Argon2id のみ。

### Negative / Trade-offs

- **封印は"消費期限つき"** (T0 までの数分のみ堅牢)。短コードゆえ永続金庫ではない → **「絶対割れない」と喧伝しない**こと。
- **窓内・同一マシンの忠実な転写は本 ADR では閉じない** → proctor + 後段の挙動分析に委ねる。
- **運用上の新依存**: 監督がコードを announce / 学生が入力。Argon2 の wasm 依存 (+1)。
- **root 式変更で `PROOF_FORMAT_VERSION` bump** が必要 (exam proof のみ)。
- **「データはブラウザ外に出ない」との緊張**: 試験モードは明示同意の別モードとして分離する (README/運用要項に明記)。

**解決済み (議論で確定):**
- 監督コード = **8 文字 Crockford Base32 (40bit)**。6 は非推奨。
- token は **proof に保存** (self-contained。out-of-band 運用は不要に)。
- **`#0 = humanAttestation` 保持・`examOpened` は #1**・genesis はコード入力時に分岐。

**未解決 / 実装フェーズ:**
- 実装 (本 ADR は Proposed; 実装は後続 PR で `PROOF_FORMAT_VERSION` bump と同時に commit し Accepted 化)。
- Argon2id の具体パラメータ最終確定 (目標 ~0.3–0.5s / ≥64 MiB。8 文字なので過激なチューニングは不要)。
- per-student variant の運用有効化 (schema は対応済み)。
- **窓内転写検出 (focus 連続性 + 転写トポロジー + keystroke↔content 整合)** は別 ADR（後段・pluggable 分析として設計; 生信号の捕捉だけは実装時に先行）。
- D-strict (QR/256bit) を strict 試験用オプションとして追加するか。

## References

- [docs/system-spec.md](../system-spec.md) — 脅威モデル・検証レイヤ
- [ADR-0002](0002-signed-checkpoints-with-ecdsa-p256.md) — ECDSA-P256 + append-only 鍵レジストリ (流用元)
- [ADR-0004](0004-verifier-checkpoint-stance.md) — 検証側スタンス
- [ADR-0005](0005-input-type-policy.md) — 許可/禁止 InputType (paste/import の構造的禁止)
- `packages/shared/src/signedCheckpoints.ts` — 署名/検証ヘルパ (流用)
- `packages/shared/src/checkpointKeys/registry.ts` — 鍵レジストリのパターン
- `packages/shared/src/typingProof/TypingProof.ts` — `initialEventChainHash` 生成 (root 式を exam モードで分岐)
