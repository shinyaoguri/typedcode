# @typedcode/workers

TypedCode 向けの Cloudflare Workers API。Turnstile 人間認証とアテステーション署名、署名済みチェックポイントの発行を担当します。

## 機能

- **Turnstile 検証**: Cloudflare Turnstile トークンを検証
- **アテステーション署名**: HMAC-SHA256 で署名付きアテステーションを発行
- **アテステーション検証**: 署名の整合性を検証
- **署名済みチェックポイントサービス**: 証明チェックポイントへの ECDSA-P256 + サーバ時刻署名。KV による per-session の `firstSeenAt` 管理を含む
- **CORS サポート**: エディタ・検証アプリ向けに CORS を設定可能

## セットアップ

### 1. Turnstile キーを取得

1. [Cloudflare ダッシュボード](https://dash.cloudflare.com/?to=/:account/turnstile)を開く
2. Turnstile ウィジェットを作成
3. **Site Key** (エディタ用) と **Secret Key** (Workers 用) をメモ

### 2. ローカル開発の設定

```bash
cp .dev.vars.example .dev.vars
```

`.dev.vars` を編集:
```
TURNSTILE_SECRET_KEY=your_secret_key_here
ATTESTATION_SECRET_KEY=any_random_string_for_signing
```

### 3. チェックポイント署名鍵の生成 (開発者ごとに 1 回)

```bash
npm run gen-checkpoint-key -w @typedcode/workers
```

実行すると以下が出力されます。

- `CheckpointPublicKey` エントリ: 開発用の鍵は `packages/shared/src/checkpointKeys/localKeys.ts` に追記し、コミット汚染を避けるため次のコマンドを実行:
  ```bash
  git update-index --skip-worktree packages/shared/src/checkpointKeys/localKeys.ts
  ```
  本番鍵は通常の PR で `packages/shared/src/checkpointKeys/registry.ts` に登録します。
- 対応する `CHECKPOINT_SIGNING_KEY_ID` と `CHECKPOINT_SIGNING_KEY_JWK`: `.dev.vars` に貼り付け。

これらが未設定の場合、`/api/checkpoint/sign` は `SIGNING_KEY_NOT_CONFIGURED` (500) を返します。それ以外のエンドポイントは動作します。

### 4. KV ネームスペースの作成 (開発者ごとに 1 回)

```bash
wrangler kv namespace create CHECKPOINT_SESSIONS
wrangler kv namespace create CHECKPOINT_SESSIONS --preview
```

`wrangler.toml` の `REPLACE_WITH_*_ID` を、コマンドが出力した ID で置き換え、誤コミット防止のために skip-worktree を付与:

```bash
git update-index --skip-worktree packages/workers/wrangler.toml
```

(共有部分を編集してコミットしたい場合は `--no-skip-worktree` で解除。コミット後に再度 skip-worktree を付け直してください。)

### 5. 開発サーバを起動

```bash
npm run dev  # http://localhost:8787
```

## API エンドポイント

### POST `/api/verify-captcha`

Turnstile トークンを検証し、署名付きアテステーションを返却します。

**Request:**
```json
{
  "token": "turnstile_response_token"
}
```

**Response (成功):**
```json
{
  "success": true,
  "score": 1.0,
  "message": "Verification successful",
  "attestation": {
    "verified": true,
    "score": 1.0,
    "action": "human_verification",
    "timestamp": "2026-01-05T10:30:00.000Z",
    "hostname": "typedcode.dev",
    "signature": "hmac_sha256_signature"
  }
}
```

**Response (失敗):**
```json
{
  "success": false,
  "score": 0,
  "message": "Verification failed"
}
```

### POST `/api/verify-attestation`

署名付きアテステーションの整合性を検証します。

**Request:**
```json
{
  "attestation": {
    "verified": true,
    "score": 1.0,
    "action": "human_verification",
    "timestamp": "2026-01-05T10:30:00.000Z",
    "hostname": "typedcode.dev",
    "signature": "hmac_sha256_signature"
  }
}
```

**Response:**
```json
{
  "valid": true,
  "message": "Attestation is valid"
}
```

### POST `/api/checkpoint/sign`

エディタからの未署名チェックポイントを、サーバの ECDSA-P256 鍵と `serverTimestamp` / `firstSeenAt` で署名します。

**Request body** (`@typedcode/shared` の `SignedCheckpointInput` 参照):
```json
{
  "sessionId": "...",
  "tabId": "...",
  "checkpointIndex": 0,
  "eventIndex": 99,
  "initialEventChainHash": "...",
  "chainHash": "...",
  "contentHash": "...",
  "previousSignedCheckpointHash": null,
  "totalEventsSincePrevious": 100,
  "clientTimestamp": "2026-05-28T12:00:00.000Z"
}
```

**Response (成功):**
```json
{ "envelope": { "payload": { ... }, "signature": "...", "keyId": "...", "algorithm": "ECDSA-P256" } }
```

**冪等性**: 同一 `sessionId` / `checkpointIndex` で `clientTimestamp` 以外が完全一致するリクエストは、前回の envelope をそのまま返します (ネットワーク不安定下での再送に対応)。

**エラーコード**: `SCHEMA_INVALID` (400), `NON_MONOTONIC` / `CHECKPOINT_CONFLICT` (409),
`SESSION_LIMIT_EXCEEDED` (429), `SIGNING_KEY_NOT_CONFIGURED` /
`SIGNING_KEY_UNKNOWN` / `SIGNING_ERROR` (500).

### GET `/api/checkpoint/public-keys`

オフライン/キャッシュでの署名検証用に、git 管理されている公開鍵レジストリを返します。

**Response:**
```json
{
  "keys": [
    {
      "keyId": "...",
      "algorithm": "ECDSA-P256",
      "publicKeyJwk": { "kty": "EC", "crv": "P-256", "x": "...", "y": "..." },
      "status": "active",
      "validFrom": "..."
    }
  ],
  "cacheTtlSec": 86400
}
```

### GET `/health`

ヘルスチェック。

**Response:**
```json
{
  "status": "ok",
  "environment": "development"
}
```

## 署名アルゴリズム (アテステーション)

HMAC-SHA256 で署名を計算します。

```typescript
const payload = JSON.stringify({
  verified: attestation.verified,
  score: attestation.score,
  action: attestation.action,
  timestamp: attestation.timestamp,
  hostname: attestation.hostname
});

const signature = HMAC_SHA256(payload, ATTESTATION_SECRET_KEY);
```

## デプロイ

### 開発

```bash
npm run dev       # ローカルサーバ起動
```

### 本番

```bash
npm run deploy:staging     # staging Worker にデプロイ (wrangler.staging.toml)
npm run deploy:production  # 本番 Worker にデプロイ (wrangler.production.toml。通常は CI 経由・承認ゲートあり)
# `npm run deploy` 単体は dev config で本番名を上書きしないよう誤実行防止でエラー終了する
```

### 本番シークレットの設定

```bash
wrangler secret put TURNSTILE_SECRET_KEY
wrangler secret put ATTESTATION_SECRET_KEY
wrangler secret put CHECKPOINT_SIGNING_KEY_ID
wrangler secret put CHECKPOINT_SIGNING_KEY_JWK
```

## 設定

### wrangler.toml

```toml
name = "typedcode-api"
main = "src/index.ts"
compatibility_date = "2025-12-26"

[vars]
ENVIRONMENT = "development"

[[kv_namespaces]]
binding = "CHECKPOINT_SESSIONS"
id = "..."
preview_id = "..."

[env.production]
vars = { ENVIRONMENT = "production" }
```

## アーキテクチャ

```
src/
├── index.ts        # エントリポイント:
│                   #   - ルーティングとリクエスト処理
│                   #   - Turnstile 検証ハンドラ
│                   #   - アテステーション検証ハンドラ
│                   #   - ヘルスチェック
│                   #   - CORS ハンドリング
│                   #   - HMAC 署名ユーティリティ
└── checkpoint.ts   # 署名済みチェックポイント:
                    #   - /api/checkpoint/sign (handleSignCheckpoint)
                    #   - /api/checkpoint/public-keys (handlePublicKeys)
                    #   - 冪等チェック・KV セッション管理
                    #   - ECDSA-P256 署名鍵のロード
```

## 環境変数

| 変数 | 説明 | 必須 |
|----------|-------------|----------|
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile のシークレット | はい |
| `ATTESTATION_SECRET_KEY` | HMAC 署名鍵 | はい |
| `CHECKPOINT_SIGNING_KEY_ID` | 署名済みチェックポイント用の keyId (`CHECKPOINT_PUBLIC_KEYS` レジストリに存在する必要あり) | `/api/checkpoint/sign` 用 |
| `CHECKPOINT_SIGNING_KEY_JWK` | ECDSA-P256 秘密鍵 (JWK の JSON 文字列) | `/api/checkpoint/sign` 用 |
| `ENVIRONMENT` | 環境名 | 任意 |

## KV ネームスペース

| Binding | 用途 | TTL |
|---------|---------|-----|
| `CHECKPOINT_SESSIONS` | per-session の `firstSeenAt`, `lastCheckpointIndex`, `lastServerTimestamp`, `signedCount`, 直前 envelope (best-effort のリプレイ防止と冪等処理用) | 7 日 |

## 依存関係

| パッケージ | バージョン | 用途 |
|---------|---------|---------|
| @typedcode/shared | * | 共有型と検証ロジック |
| wrangler | ^4.92 | Cloudflare Workers CLI |
| @cloudflare/workers-types | * | TypeScript の型定義 |

## セキュリティ上の注意

1. **シークレット**: `.dev.vars` を絶対にコミットしない。本番では `wrangler secret put` を使う
2. **CORS**: 許可するオリジンを適切に設定する
3. **レートリミット**: 本番では追加のレートリミットを検討
4. **署名検証**: アテステーション署名はサーバ側でも必ず検証する
5. **公開鍵管理**: 本番鍵は `packages/shared/src/checkpointKeys/registry.ts` に append-only で追加し、`status: 'revoked'` で失効管理する
