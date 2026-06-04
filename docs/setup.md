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

---

# CI / 本番デプロイの設定 (メンテナ向け)

メンテナとして GitHub Actions から自動でデプロイを enable する場合、以下を 1 回設定すれば以降は `develop` push → staging 自動、`main` push → production 承認待ちのフローで回ります。

## M1. Cloudflare API トークンの発行

CI が `wrangler` を使ってデプロイするので、適切な権限の API トークンが必要です。**権限が足りないと CI が `Authentication error [code: 10000]` で落ちます** (実際に踏みました)。

### 手順

1. [Cloudflare ダッシュボード → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens) を開く
2. **Create Token** → **Custom token**
3. **必要な権限** (4 つ全部必要):

   | 種類 | リソース | 権限 |
   |---|---|---|
   | Account | Cloudflare Pages | **Edit** |
   | Account | Workers Scripts | **Edit** |
   | Account | Workers KV Storage | **Edit** |
   | User | User Details | Read |

   - Pages の Edit が無いと Pages デプロイで落ちる
   - Workers Scripts の Edit が無いと Workers デプロイで落ちる
   - Workers KV Storage の Edit が無いと KV bindings が作れず落ちる
   - User Details Read は account ID 取得用

4. **Account Resources**: `Include` → 自アカウントを選択 (`All accounts` でも可)
5. **Zone Resources**: `Include` → `All zones`
6. **Client IP Address Filtering / TTL**: 空欄で OK
7. **Create Token** → 出力される文字列を控える (**一度しか見られない**)

### account ID の取得

ダッシュボード右側 (またはトップページ右下) に **Account ID** が表示されているのでコピーする。

## M2. GitHub repo に Secrets を投入

### Repo level (Settings → Secrets and variables → Actions → New repository secret)

| Secret | 値 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | M1 で控えた token 文字列 |
| `CLOUDFLARE_ACCOUNT_ID` | account ID |
| `CLOUDFLARE_PROJECT_NAME` | Cloudflare Pages のプロジェクト名 (例: `typedcode`) |

### GitHub Environments の作成

Settings → Environments → **New environment**:

#### Environment `staging` (承認不要、develop push で自動デプロイ)
- Secrets (Add secret):

  | Secret | 値 |
  |---|---|
  | `VITE_API_URL` | staging Worker の URL (`https://typedcode-api-staging.<your-subdomain>.workers.dev`) |
  | `VITE_TURNSTILE_SITE_KEY` | staging 用 Turnstile widget の Site Key |

#### Environment `production` (承認ゲート付き、main push でのみ動作)
- Secrets:

  | Secret | 値 |
  |---|---|
  | `VITE_API_URL` | 本番 Worker の URL |
  | `VITE_TURNSTILE_SITE_KEY` | 本番 Turnstile Site Key |

- **Deployment protection rules** → **Required reviewers** を ON にして自分 (またはチーム) を 1 名以上追加
  → これで `main` push 時に Actions タブで Approve を押すまで本番デプロイが保留される

## M3. Cloudflare 側の準備

### 環境ごとの KV ネームスペース作成

```bash
cd packages/workers
wrangler kv namespace create CHECKPOINT_SESSIONS_STAGING
wrangler kv namespace create CHECKPOINT_SESSIONS_PRODUCTION
```

出力された 2 つの ID を [packages/workers/wrangler.staging.toml](../packages/workers/wrangler.staging.toml) / [packages/workers/wrangler.production.toml](../packages/workers/wrangler.production.toml) の `id = "..."` に貼り付け commit する (KV ID は秘密情報ではない)。

### Turnstile widget (staging / production 別に作成推奨)

[Turnstile dashboard](https://dash.cloudflare.com/?to=/:account/turnstile) で:

- **staging widget**: Domain に staging Pages URL (例: `develop.typedcode.pages.dev`) を許可
- **production widget**: Domain に本番ドメインを許可

それぞれの **Site Key** を GitHub Environment Secrets (M2 で投入)、**Secret Key** を後で wrangler secret で投入する。

### Worker 個別シークレット投入

Pages bundle の `VITE_API_URL` 等は GitHub Secrets で済みますが、Worker 内で動くシークレット (`TURNSTILE_SECRET_KEY` 等) は **`wrangler secret put` で Worker に直接** 投入します。

```bash
cd packages/workers

# staging Worker
wrangler secret put TURNSTILE_SECRET_KEY --config wrangler.staging.toml
wrangler secret put ATTESTATION_SECRET_KEY --config wrangler.staging.toml      # openssl rand -hex 32
wrangler secret put CHECKPOINT_SIGNING_KEY_ID --config wrangler.staging.toml   # M4 で生成
wrangler secret put CHECKPOINT_SIGNING_KEY_JWK --config wrangler.staging.toml  # M4 で生成

# production Worker (同じ 4 件、値は別物にする)
wrangler secret put TURNSTILE_SECRET_KEY --config wrangler.production.toml
wrangler secret put ATTESTATION_SECRET_KEY --config wrangler.production.toml
wrangler secret put CHECKPOINT_SIGNING_KEY_ID --config wrangler.production.toml
wrangler secret put CHECKPOINT_SIGNING_KEY_JWK --config wrangler.production.toml
```

## M4. 環境ごとの署名鍵を登録

staging と production で別の ECDSA-P256 鍵対を使うのが安全 (片方が漏れても他方が無事)。

```bash
# staging 鍵
npm run gen-checkpoint-key -w @typedcode/workers
# → 出力された keyId / publicKey entry / privateKey JWK を控える

# production 鍵
npm run gen-checkpoint-key -w @typedcode/workers
# → 同上
```

それぞれ:

1. **公開鍵 entry** を [packages/shared/src/checkpointKeys/registry.ts](../packages/shared/src/checkpointKeys/registry.ts) の `CHECKPOINT_PUBLIC_KEYS` 配列に **append** (既存エントリは削除しない、`status: 'active'` で追加)
2. **keyId** と **privateKey JWK** を M3 の `wrangler secret put` で対応 Worker に投入
3. commit & push (registry.ts 変更)

## M5. 動作確認

`develop` ブランチに空 commit を push:

```bash
git commit --allow-empty -m "trigger CI smoke test"
git push origin develop
```

GitHub Actions タブで:

- ✓ `test` (shared 177 + workers 12 件のテスト)
- ✓ `deploy-staging` (Workers + Pages の develop branch)
- ⊘ `deploy-preview` (skipped, push event のため)
- ⊘ `deploy-production` (skipped, develop なため)

すべて green なら、本番リリースは `develop → main` のマージで自動的に承認待ちになります。

## トラブルシューティング (CI)

### `Authentication error [code: 10000]`

CF API token の権限不足。M1 の権限 4 種類が全部設定されているか確認。

### `Pages API failed: Invalid commit message [code: 8000111]`

CF Pages API が非 ASCII コミットメッセージを弾くケース。`deploy.yml` で `--commit-message="${{ github.sha }}"` を渡しているはずなので、ここを削っていないか確認。

### `deploy-staging` と `deploy-preview` が両方走る

`develop` を head にした PR (例: `develop → main`) を開いていると起きる。`deploy-preview` の if 条件に `github.head_ref != 'develop'` が入っているか確認。

### 本番デプロイが承認待ちにならず即実行される

`production` Environment に Required reviewers が設定されていない。M2 を再確認。

---

## 関連ドキュメント

- [README.md](../README.md) — プロジェクト概要
- [CLAUDE.md](../CLAUDE.md) — リポジトリ全体の玄関口
- [packages/workers/CLAUDE.md](../packages/workers/CLAUDE.md) — Workers サブシステムの責務と不変条件
- [docs/system-spec.md](system-spec.md) — システム仕様
