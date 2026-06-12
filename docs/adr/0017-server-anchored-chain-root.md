# ADR-0017: セッション開始 ECDSA トークンでチェーン根をサーバアンカーする

- **Status**: Accepted
- **Date**: 2026-06-12
- **Deciders**: develop レビュー (Phase 7 / ADR-A)
- **PR / Commit**: `feat/phase7-session-anchor`

## Context

casual / class proof のチェーン根は `root = SHA256(fingerprintHash ‖ localNonce)` で、**両入力ともクライアント選択**である。
したがって proof 全体を**完全オフラインで捏造**できる (PoSW は 10,000 反復・native ~3.9ms/event で 5000 event を ~19s で偽造可能 = 主張時間と PoSW work が分離している)。実時間を束縛する唯一の要素は署名チェックポイント (ADR-0002) の `serverTimestamp` だが、ADR-0016 (密度 gate) を入れても「主張時間ぶん実際にサーバへ周期接続する」ことを強いるだけで、**開始時刻そのもの**はアンカーされない。

加えて人間認証 (attestation) は HMAC で発行されるだけで、**sessionId / 期限 / nonce に束縛されず・検証側で照合もされない** (`/api/verify-attestation` は dead = クライアント呼出なし)。リプレイ可能で証拠価値が薄い。

脅威の核心:
- **① オフライン捏造 / 遡及生成**: root に server 由来の値が無いため、いつでも・過去日付でも proof を作れる。
- **④ attestation の非束縛・未検証**: 人間ゲートが proof の root と暗号的に結びついていない。

## Considered Options

### 開始時の可用性 vs 強度

#### Option a: session/start 必須 (トークン取得まで編集ブロック)
- Pros: 全 proof が必ず server-anchored。
- Cons: 教室の不安定網で**開始できない**事故。可用性を壊す。

#### Option b (採用): 劣化許容フォールバック
- session/start 不達なら serverNonce 無しの旧式 root にフォールバックし、proof に `rootAnchored:false` を明示。
  verify は「root 未アンカー」を warning 表示。**high-stakes は採点ポリシーで root-anchored 必須を opt-in** にできる。
- Pros: 可用性を保ちつつ、成功時は強くなる。段階導入できる (旧 proof と共存)。
- Cons: 「未アンカー」proof が引き続き存在する (ただし正直に表示される)。

### 署名鍵

- **採用: checkpoint の ECDSA レジストリ/鍵を流用** (運用一系統)。`checkpointKeys/registry.ts` + workers `getSigningKey`。
  C1 (ADR の registry-only 信頼) と同じ resolve でオフライン検証可能。新鍵系統を増やさない。
- 却下: セッショントークン専用の鍵系統 → 運用二重化・rotation/revoke の手間増。

### フォーマット

- **採用: `PROOF_FORMAT_VERSION` 1.1.0 → 1.2.0、`MIN_SUPPORTED_VERSION` は 1.0.0 据え置き**。
  旧 proof (token 無し) は `rootAnchored:false` で受理 = 後方互換。`sessionStartToken` / `rootAnchored` は加算的フィールド。

## Decision (proposed)

セッション開始時に **ECDSA 署名済みトークンを 1 つ発行し、その `serverNonce` を root に焼く**。Turnstile でゲートする。

```
POST /api/session/start { turnstileToken, sessionId, fingerprintHash }
→ verifyTurnstile (既存) でゲート
→ token = { v, sessionId, serverNonce(32B hex), issuedAt(server ISO),
            turnstileVerified, hostname, action, poswIterations }
   signature = ECDSA-P256(deterministicStringify(token))   // checkpoint 鍵で署名
   keyId, algorithm
→ { token, signature, keyId, algorithm }   // CORS は resolveCorsOrigin
```

casual / class の root を以下に拡張 (exam は §Open questions の通り当面据え置き):
```
root = SHA256(fingerprintHash ‖ localNonce ‖ serverNonce)
```

**検証器** (オフライン完結):
1. `sessionStartToken` の ECDSA を registry で検証 (C1 と同じ registry-only resolve。未登録 keyId は埋め込み鍵があっても拒否)。
2. 鍵の有効期間/失効を `issuedAt` を anchor に判定 (署名 cp と同じ規約)。
3. serverNonce 込みで root 再計算 = `initialEventChainHash`。
4. `token.sessionId` が署名 cp の `sessionId` と一致 (アンカーとチェーンの結びつき)。
5. root の `issuedAt` 以降にチェーンが始まる (時系列整合)。
→ ① (オフライン捏造/遡及封鎖) と ④ (attestation を ECDSA 束縛 + オフライン検証可) を同時達成。

**フォールバック (Option b)**: session/start 不達なら旧式 `SHA256(fp ‖ localNonce)` root にフォールバックし
`rootAnchored:false`。verify は warning。strict (採点) は `requireRootAnchor` opt-in で fail にできる
(ADR-0016 の `requireAnchorDensity` と同じ「既定 warning / opt-in strict」パターン)。

編集側は exam の `initializeExam` と同じ「**トークン取得後に root 確定**」フローを casual/class に導入する
(`initializeAnchored(fp, components, serverNonce, token)` を新設、または `initialize` に任意 token を渡す)。
取得失敗時は従来 `initialize` にフォールバック。

**作成時 Turnstile の統合 (確定)**: session/start を **#0 の人間ゲートと統合**する。1 回の Turnstile 解決で
ECDSA トークン発行 = root アンカー = 人間ゲートを兼ねる。`#0 humanAttestation` イベントは引き続き記録するが、
その暗号的束縛は **proof 同梱の ECDSA `sessionStartToken`** (registry でオフライン検証可) が担い、HMAC attestation の
作成経路 (`/api/verify-captcha` → `createAttestation`) は **editor の作成フローから外す**。これにより脅威④
(attestation の非束縛・未検証) を直接解消する。dead な `/api/verify-attestation` は deprecate。pre-export
attestation は別用途として当面据え置く (作成時 root とは独立)。

## Compatibility & Availability (詰め)

| proof | version | sessionStartToken | 検証器の扱い |
|---|---|---|---|
| 旧 (既存) | 1.0.0 / 1.1.0 | 無 | `rootAnchored:false` + warning。valid は他レイヤで成立 (後方互換) |
| 新・成功 | 1.2.0 | 有 | token 検証 → serverNonce 込み root 再計算。`rootAnchored:true` |
| 新・劣化 | 1.2.0 | 無 | `rootAnchored:false` + warning (オフライン開始)。strict 採点では fail 可 |

- `MIN_SUPPORTED_VERSION` を上げないので、既存 proof は引き続き検証できる (fail-closed にしない)。
- exam proof は root 式が別 (ADR-0006)。当面 serverNonce を足さない → 既存の exam 検証は不変。
- editor は session/start を**非ブロッキング**に呼ぶ。失敗は warning 表示のみで編集は継続。

## Consequences

### Positive
- casual/class の **完全オフライン捏造・遡及生成**を封じる (成功時)。開始時刻が server-anchored になる。
- attestation が ECDSA + serverNonce 束縛になり、**verify-cli/verify(web) がオフラインで検証可能**になる (dead な HMAC 経路を置換)。
- 鍵運用は checkpoint と一系統。検証は registry-only (C1) で長期検証可能。

### Negative / Trade-offs
- **format bump (1.2.0)**。editor / workers / shared / verify / verify-cli を横断する大型変更。
- 劣化フォールバックを残すため「未アンカー proof」は無くならない (正直に表示はする)。
- **正直な天井 (再 overclaim 禁止)**: ①+③ が揃っても、「**実時間でサーバ通信しながら CDP 等で isTrusted=true な合成入力を流すライブ台本セッション**」は valid な proof を作れる。Phase 7 の価値は「19 秒のオフライン捏造 → 主張時間ぶんサーバ接続を強制」への**経済性転換**であって、ライブ台本の封殺ではない。proctor + 挙動分析の領域。README/spec はこの範囲を超えない。

### Follow-ups / 残課題
- exam root への serverNonce 連結 (開始時刻アンカー) は別 ADR / 後続 (EXAM_ROOT_BINDING v3 として検討)。
- 旧 `/api/verify-attestation` (HMAC, dead) は deprecate 注記。pre-export attestation の扱いは §Open questions。
- ADR-C (isTrusted 捕捉) は本 ADR と独立に加算。

## 確定した設計判断 (2026-06-12 レビュー)

1. **exam スコープ**: **casual/class に限定**。exam は既に startToken で T0 束縛済み (ADR-0006) のため、
   serverNonce 連結 (開始時刻アンカー) は **後続 ADR (EXAM_ROOT_BINDING v3) に分離**。今回 exam 検証経路は不変。
2. **作成時 Turnstile**: **統合**。session/start の 1 回の Turnstile で ECDSA トークン発行 = root アンカー =
   人間ゲートを兼ねる。HMAC attestation の作成経路を editor から外す (上記 Decision 参照)。
3. **進め方**: 本 ADR を Accepted とし、**実装まで一気に**進める (shared → workers → editor → verify/cli → tests → docs)。

## References

- root 計算: [`HashChainManager.ts`](../../packages/shared/src/typingProof/HashChainManager.ts) `generateInitialHash` / `generateExamInitialHash`、[`verification.ts`](../../packages/shared/src/verification.ts) `verifyInitialHashRoot`
- 「トークン後に root 確定」既存パターン: [`TypingProof.ts`](../../packages/shared/src/typingProof/TypingProof.ts) `initializeExam`
- 鍵/署名の流用元: [`checkpoint.ts`](../../packages/workers/src/checkpoint.ts) `getSigningKey`、[`signedCheckpoints.ts`](../../packages/shared/src/signedCheckpoints.ts) `resolveCheckpointPublicKey` (registry-only = C1)
- worker 既存ヘルパ: [`index.ts`](../../packages/workers/src/index.ts) `verifyTurnstile` / `resolveCorsOrigin` / `handleVerifyCaptcha`
- 関連 ADR: [ADR-0002](0002-signed-checkpoints-with-ecdsa-p256.md) / [ADR-0006](0006-exam-mode-sealed-problem-binding.md) (exam root) / [ADR-0016](0016-anchoring-density-signal.md) (密度 gate) / ADR-0007 (isTrusted = ADR-C)
- 脅威の出所: [[review-develop-2026-06]] の concept-alignment 節
