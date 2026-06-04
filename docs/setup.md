# 開発環境セットアップ

このドキュメントはローカル開発環境を 0 から構築する手順です。`npm run doctor` で各ステップの完了状況を確認できます。

## 必要なもの

- **Node.js 24+** (`.node-version` に `24.4.1`、`engines.node: >=24`)
- **npm 10+**
- **Cloudflare アカウント** (Workers + Pages 無料枠で十分)
- **Wrangler CLI** (npm install で同梱されるので追加インストール不要)

## 手順

### Step 1: clone と install

```bash
git clone git@github.com:shinyaoguri/typedcode.git
cd typedcode
npm install
```

### Step 2: 設定状況を確認

```bash
npm run doctor
```

未設定のものが一覧表示されます。以降の Step は doctor の出力に従って実施してください。

### Step 3: Cloudflare のリソース作成

[Cloudflare dashboard](https://dash.cloudflare.com/) にログインして以下を作成します:

**(a) Turnstile widget** (人間認証用、任意)

[Turnstile](https://dash.cloudflare.com/?to=/:account/turnstile) → Add Site:
- Domain: `localhost` (ローカル開発のみなら)
- Mode: Managed
- 作成後、**Site Key** (公開) と **Secret Key** (Worker 用) を控える

**(b) KV ネームスペース** (cp セッション state 保管用)

```bash
cd packages/workers
wrangler kv namespace create CHECKPOINT_SESSIONS
wrangler kv namespace create CHECKPOINT_SESSIONS --preview
```

出力された 2 つの ID を控える。

### Step 4: ローカル設定ファイル

**(a) editor**

```bash
cp packages/editor/.env.example packages/editor/.env
```

[packages/editor/.env](../packages/editor/.env) を編集:
```
VITE_TURNSTILE_SITE_KEY=<Step 3a の Site Key、なくても可>
VITE_API_URL=http://localhost:8787
```

**(b) workers (シークレット)**

```bash
cp packages/workers/.dev.vars.example packages/workers/.dev.vars
```

[packages/workers/.dev.vars](../packages/workers/.dev.vars) を編集:
```
TURNSTILE_SECRET_KEY=<Step 3a の Secret Key、なくても可>
ATTESTATION_SECRET_KEY=<openssl rand -hex 32 の出力など、任意の文字列>
CHECKPOINT_SIGNING_KEY_ID=<Step 5 で生成>
CHECKPOINT_SIGNING_KEY_JWK=<Step 5 で生成>
```

**(c) workers (KV ID)**

`packages/workers/wrangler.toml` のトップレベル `[[kv_namespaces]]` ブロックを編集:
```toml
[[kv_namespaces]]
binding = "CHECKPOINT_SESSIONS"
id = "<Step 3b の id>"
preview_id = "<Step 3b の preview id>"
```

(env.* ブロックは触らない。あれは CI deploy 用)

skip-worktree を当てて git status に出ないようにする:
```bash
git update-index --skip-worktree packages/workers/wrangler.toml
```

### Step 5: 署名鍵を生成

ローカル開発用に **ECDSA-P256 鍵対**を 1 つ作る。本番/staging 鍵とは別物にすること (登録済鍵を流用すると、ローカルが本番鍵対と区別不能になる)。

```bash
cp packages/shared/src/checkpointKeys/localKeys.ts.example packages/shared/src/checkpointKeys/localKeys.ts
git update-index --skip-worktree packages/shared/src/checkpointKeys/localKeys.ts

npm run gen-checkpoint-key -w @typedcode/workers
```

出力には 3 パートあるので、それぞれ以下に貼り付け:

1. `=== Public key entry ===` の JSON → `packages/shared/src/checkpointKeys/localKeys.ts` の `LOCAL_CHECKPOINT_PUBLIC_KEYS` 配列に append
2. `CHECKPOINT_SIGNING_KEY_ID=...` → `packages/workers/.dev.vars` の対応行
3. `CHECKPOINT_SIGNING_KEY_JWK={...}` → `packages/workers/.dev.vars` の対応行 (JWK の 1 行 JSON)

### Step 6: 確認

```bash
npm run doctor
```

すべて ✓ なら準備完了:

```bash
npm run dev
# http://localhost:5173 が editor
# http://localhost:5174 が verify
# http://localhost:8787 が workers
```

### Step 7 (任意): Cloudflare 側の検証

```bash
npm run doctor -- --cf
```

`wrangler whoami` と KV namespace 突合を実施します。

## トラブルシューティング

### doctor で fail が出る

出力の `> 何を、どこに、どう書く` を順に直してください。1 件直したら再度 `npm run doctor` で確認します。

### `wrangler whoami` が `Not authenticated` を返す

```bash
wrangler login
```
でブラウザ認証するか、`CLOUDFLARE_API_TOKEN` 環境変数を設定。

### Worker 起動で `SIGNING_KEY_NOT_CONFIGURED`

`packages/workers/.dev.vars` の `CHECKPOINT_SIGNING_KEY_ID` と `CHECKPOINT_SIGNING_KEY_JWK` を確認。両方 set されているか。

### Worker 起動で `SIGNING_KEY_UNKNOWN`

`.dev.vars` の keyId が `packages/shared/src/checkpointKeys/{registry,localKeys}.ts` のいずれにも存在しない状態。Step 5 で `LOCAL_CHECKPOINT_PUBLIC_KEYS` に対応する公開鍵 entry を append したか確認。

### 検証で envelope の署名検証失敗

サーバ (Worker) と検証側 (verify) の鍵対が一致していない可能性。Step 5 を再度実行して鍵対を作り直す。

## CI / 本番デプロイの設定 (メンテナ向け)

メンテナとして CI 経由で staging / production デプロイを enable したい場合は [packages/workers/CLAUDE.md](../packages/workers/CLAUDE.md) を参照。GitHub Environments と secrets の設定が別途必要です。

## 関連ドキュメント

- [README.md](../README.md) — プロジェクト概要
- [CLAUDE.md](../CLAUDE.md) — リポジトリ全体の玄関口
- [packages/workers/CLAUDE.md](../packages/workers/CLAUDE.md) — Workers と CI deploy 設定
- [docs/system-spec.md](system-spec.md) — システム仕様
