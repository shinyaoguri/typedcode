# packages/workers — 運用 (観測性・ローカル開発・デプロイ)

wrangler の設定、シークレットの宣言、ローカルの立ち上げ、デプロイ環境と CI の前提を触るときに読む。[AGENTS.md](../AGENTS.md) から移した節。初回セットアップの手順の正本は [docs/setup.md](../../../docs/setup.md)。

## 観測性・シークレット宣言・型 (運用)

`wrangler.{staging,production}.toml` に以下を宣言している (dev の `wrangler.toml` は skip-worktree なので対象外):

- **`[observability] enabled = true`**: Workers Logs を有効化。`head_sampling_rate = 1` は低トラフィックな署名 API 向けに全リクエスト記録。トラフィックが増えたら下げる。
- **`[secrets] required = [...]`**: `TURNSTILE_SECRET_KEY` / `CHECKPOINT_SIGNING_KEY_ID` / `CHECKPOINT_SIGNING_KEY_JWK` を必須宣言 (export 前アテステーションの署名用 secret は #415 で外した。Worker に残っていても無害で、消す順序は CHANGELOG)。`wrangler secret put` 漏れがあると **deploy 時にエラー**になり、設定漏れによる本番事故を防ぐ。`--dry-run` (CI の config 検証) では secret の存在チェックは走らない。

**Env の型**: 現状 `src/index.ts` の `Env` / `checkpoint.ts` の `CheckpointEnv` は手書き。`npm run cf-typegen` (= `wrangler types`) で config から `worker-configuration.d.ts` を生成できる (gitignore 済み・commit しない)。生成された runtime types へ完全移行 (= `@cloudflare/workers-types` を外し tsconfig を更新、手書き `Env` を撤去) は**別途の follow-up**。今は手書き `Env` が source of truth なので、binding を増やしたら手書き側も更新すること。

## ローカル開発のフロー

1. `cp .dev.vars.example .dev.vars` で雛形コピー
2. Turnstile キーを `.dev.vars` に貼り付け
3. `npm run gen-checkpoint-key -w @typedcode/workers` で開発用鍵生成
4. 公開鍵を `packages/shared/src/checkpointKeys/localKeys.ts` に貼り付け (gitignore 済み。無ければ `npm install` / `npm run doctor` が `.example` から作る。#338)
5. 秘密鍵 (`CHECKPOINT_SIGNING_KEY_JWK`) と `CHECKPOINT_SIGNING_KEY_ID` を `.dev.vars` に貼り付け
6. `wrangler kv namespace create CHECKPOINT_SESSIONS` で KV 作成し `wrangler.toml` の ID を置換 (こちらも skip-worktree)
7. `npm run dev` で http://localhost:8787

詳細は [packages/workers/README.md](../README.md) を参照。

## デプロイ環境 (3 系統)

| 環境 | wrangler 設定 | トリガ | Worker 名 |
|---|---|---|---|
| dev (ローカル) | `wrangler.toml` (skip-worktree) | `npm run dev` | (local) |
| staging | `wrangler.staging.toml` | **main push → CI 自動** | `typedcode-api-staging` |
| production | `wrangler.production.toml` | **正式版の昇格・patch → タグの ref の workflow_dispatch → CI 承認待ち** | `typedcode-api` |

- staging / production の wrangler config は KV ID も含めて HEAD に直接 commit されている (KV namespace ID は CF API token なしではアクセス不能なので実質的にシークレットではない)
- ローカル `wrangler.toml` は各開発者の dev KV ID を保持 (skip-worktree のため commit されない)
- staging Worker は別名 (`typedcode-api-staging`) として登録され、production と完全独立

### CI デプロイの前提 (GitHub Environments + Secrets)

GitHub repo の Settings → Environments に **2 つの環境** を作成:

**Repo level (Settings → Secrets and variables → Actions)**
- `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_PROJECT_NAME` (環境共通)
- **`CLOUDFLARE_API_TOKEN` は repo level に置かない** — 後述の通り Environment ごとに分ける (preview/staging で本番デプロイ権限の token を露出させない)

**Environment `staging`** (承認なし、自動デプロイ。preview もこの環境)
- Secrets:
  - `CLOUDFLARE_API_TOKEN` — **staging/preview 専用** (Pages:Edit + staging Worker のみ。本番 Worker 権限なし)
  - `VITE_API_URL` — staging Workers の URL (ビルド時に bundle に baked-in)
  - `VITE_TURNSTILE_SITE_KEY` — Cloudflare の公開テスト用 site key `1x00000000000000000000AA` (ADR-0049)

**Environment `production`** (Required reviewers 設定推奨 = 承認待ち)
- Secrets:
  - `CLOUDFLARE_API_TOKEN` — **本番専用** (承認ゲート配下なので Approve を経ないと使われない)
  - `VITE_API_URL` — 本番 Workers の URL
  - `VITE_TURNSTILE_SITE_KEY` — 本番 Turnstile site key
- **Protection rule**: Required reviewers に 1 名以上 (自分でもよい) → main push 時に Actions タブで手動承認が必要になる

> deploy job は全て `environment:` を宣言済みなので、Environment secret は同名 repo secret を**自動上書き**する。ワークフロー変更は不要。

(KV namespace ID は wrangler.{staging,production}.toml に直接 commit するので環境 secret には入れない)

### Workers 個別 secrets (Wrangler 経由)

`wrangler secret put` は Worker 名ごとに別管理。staging と production で別々に投入:

```bash
# staging Worker (typedcode-api-staging)
cd packages/workers
wrangler secret put TURNSTILE_SECRET_KEY --config wrangler.staging.toml
wrangler secret put CHECKPOINT_SIGNING_KEY_ID --config wrangler.staging.toml
wrangler secret put CHECKPOINT_SIGNING_KEY_JWK --config wrangler.staging.toml

# production Worker (typedcode-api)
wrangler secret put TURNSTILE_SECRET_KEY --config wrangler.production.toml
# ... 同様
```

### 初回セットアップ手順

```bash
# 1. KV ネームスペース作成 (staging + production)
wrangler kv namespace create CHECKPOINT_SESSIONS_STAGING
wrangler kv namespace create CHECKPOINT_SESSIONS_PRODUCTION
# → 出力された 2 つの ID を GitHub Environment Secrets に投入

# 2. 署名鍵生成 (環境ごとに別鍵を推奨)
npm run gen-checkpoint-key -w @typedcode/workers   # staging 用
npm run gen-checkpoint-key -w @typedcode/workers   # production 用
# → 各 keyId を packages/shared/src/checkpointKeys/registry.ts に append (永続)
# → JWK は対応 Worker に wrangler secret put

# 3. 各 Worker に他のシークレット (TURNSTILE_SECRET_KEY 等) を投入

# 4. GitHub Environment "production" に Required reviewers を 1 名以上設定
```

### デプロイの流れ (運用)

```
ローカル開発 (npm run dev)
   ↓ feature ブランチ → PR → squash merge
main ブランチ push
   ↓
[CI] test → deploy-staging (auto)
   ↓
post-deploy 検査 (ヘッダ・署名鍵・CORS) → staging のブラウザ E2E
   ↓ release.yml の promote (beta → 正式版) か patch (release/A.B)。タグを打ち、タグの ref で deploy.yml を起こす
[CI] test → deploy-production (タグの位置の検証 → 承認待ち)
   ↓ Actions タブで Approve
本番デプロイ実行 (Workers → Pages の順。不変条件 10)
```

本番が壊れて直前の版へ戻すときの手順 (Pages → Workers の順、staging では Pages の rollback が使えないこと、戻らない状態) は [CONTRIBUTING.md「本番を戻す」](../../../CONTRIBUTING.md#本番を戻す-ロールバック) にある。
