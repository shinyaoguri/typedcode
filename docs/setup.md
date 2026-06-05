# 開発環境セットアップ

このドキュメントはローカル開発環境を 0 から構築する手順です。`npm run doctor` で各ステップの完了状況を確認できます。

## 0. 前提 (絶対必要なもの)

これだけあれば doctor が動きます。残りは doctor が順に案内します。

| ツール | バージョン | インストール |
|---|---|---|
| **Node.js** | 24+ | macOS: `brew install node` / Linux: nvm or apt / Windows: [nodejs.org](https://nodejs.org/) |
| **npm** | 10+ | Node に同梱 |
| **git** | 任意 | macOS: `xcode-select --install` / Linux: `apt install git` / Windows: [git-scm.com](https://git-scm.com/) |

**Cloudflare アカウントは Step 3 で作成**します (無料、決済情報不要)。clone してすぐ doctor を走らせれば、必要なタイミングで「Cloudflare 登録 + `wrangler login` してください」と案内が出ます。

> **Cloudflare 抜きで試したい場合**: editor のタイピング + ハッシュチェーン + ローカル検証は Workers 無しでも動作します。ただし時刻アンカリング (signed checkpoints) と人間認証 (Turnstile) は無効。`packages/editor/.env` の `VITE_API_URL` を空にして `npm run dev:editor` だけ起動すれば最小限の動作確認が可能です。

## 1. clone と install

```bash
git clone git@github.com:shinyaoguri/typedcode.git   # https クローンでも可
cd typedcode
npm install
```

これで **wrangler CLI もこのリポジトリ内に install** されます (グローバルインストール不要、すべて `npx wrangler ...` で呼べる)。

## 2. 設定状況を確認

```bash
npm run doctor
```

doctor は 6 セクションを順に検査します:

1. 基礎ツール (Node / npm / git)
2. ワークスペース (npm install 済か、wrangler が見つかるか)
3. **Cloudflare アカウント** (`wrangler whoami` で認証状態を確認 ← ここで未認証なら登録 + login 案内が出ます)
4. ローカル設定ファイル (`.env`, `.dev.vars`, `wrangler.toml`)
5. 署名鍵 (`localKeys.ts`, `.dev.vars` の keyId/JWK)
6. Cloudflare リソース突合 (`--cf` フラグで KV の実在確認)

各 fail / warn に「何を、どこで、どう書くか」が出ます。以降の Step はその出力に沿って実施してください。

### Step 3: Cloudflare アカウント作成 + ログイン

doctor の Section 3 で「Cloudflare に未認証」と出たら以下を実行:

```bash
# (1) アカウント未作成なら https://dash.cloudflare.com/sign-up で無料登録
#     Email + パスワードのみ、決済情報は不要
# (2) wrangler を CF と接続
npx wrangler login
```

ブラウザが開いて「TypedCode が Cloudflare アカウントにアクセスすることを許可」というプロンプトが出るので Allow。完了後 `npx wrangler whoami` で確認 (account ID が返れば OK)。

### Step 4: Cloudflare のリソース作成

**(a) Turnstile widget** (人間認証用、任意)

[Turnstile dashboard](https://dash.cloudflare.com/?to=/:account/turnstile) → Add Site:
- Domain: `localhost` (ローカル開発のみなら)
- Mode: Managed
- 作成後、**Site Key** (公開) と **Secret Key** (Worker 用) を控える

**(b) KV ネームスペース** (cp セッション state 保管用)

```bash
cd packages/workers
npx wrangler kv namespace create CHECKPOINT_SESSIONS
npx wrangler kv namespace create CHECKPOINT_SESSIONS --preview
```

出力された 2 つの ID を控える。

### Step 5: ローカル設定ファイル

**(a) editor**

```bash
cp packages/editor/.env.example packages/editor/.env
```

[packages/editor/.env](../packages/editor/.env) を編集:
```
VITE_TURNSTILE_SITE_KEY=<Step 4a の Site Key、なくても可>
VITE_API_URL=http://localhost:8787
```

**(b) workers (シークレット)**

```bash
cp packages/workers/.dev.vars.example packages/workers/.dev.vars
```

[packages/workers/.dev.vars](../packages/workers/.dev.vars) を編集:
```
TURNSTILE_SECRET_KEY=<Step 4a の Secret Key、なくても可>
ATTESTATION_SECRET_KEY=<次の Node ワンライナーの出力など、任意の文字列>
CHECKPOINT_SIGNING_KEY_ID=<Step 6 で生成>
CHECKPOINT_SIGNING_KEY_JWK=<Step 6 で生成>
```

`ATTESTATION_SECRET_KEY` の生成 (どちらでも OK):
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# または openssl があれば
openssl rand -hex 32
```

**(c) workers (KV ID)**

`packages/workers/wrangler.toml` のトップレベル `[[kv_namespaces]]` ブロックを編集:
```toml
[[kv_namespaces]]
binding = "CHECKPOINT_SESSIONS"
id = "<Step 4b の id>"
preview_id = "<Step 4b の preview id>"
```

(env.* ブロックは触らない。あれは CI deploy 用)

skip-worktree を当てて git status に出ないようにする:
```bash
git update-index --skip-worktree packages/workers/wrangler.toml
```

### Step 6: 署名鍵を生成

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

### Step 7: 確認

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

### Step 8 (任意): Cloudflare リソースの突合

```bash
npm run doctor -- --cf
```

`wrangler.toml` に書いた KV ID が Cloudflare 上の実 KV と一致しているかを確認します。

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

## M2. GitHub repo に Secrets と設定を投入

### Repo 設定 (Settings → General)

- **Automatically delete head branches** → **OFF**
  (= API: `delete_branch_on_merge: false`)
  ON のままだと PR マージ時に `develop` ブランチが削除されてしまい、staging デプロイのソースが消えます。今日この事故が発生したので必ず OFF に。

  ```bash
  gh api -X PATCH repos/<owner>/<repo> -F delete_branch_on_merge=false
  ```

### Repo level secrets (Settings → Secrets and variables → Actions → New repository secret)

| Secret | 値 |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | account ID |
| `CLOUDFLARE_PROJECT_NAME` | Cloudflare Pages のプロジェクト名 (**M3 で作成**したもの) |

> **`CLOUDFLARE_API_TOKEN` は repo level に置かない**。preview / staging / production で同一 token を共用すると、PR プレビュー (= fork や任意ブランチから走り得る) でも本番デプロイ権限を持つ token が露出する。**Environment secret として環境ごとに分け**、production token は production Environment (承認ゲート配下) に置く。
>
> deploy job はすべて `environment:` を宣言しているので、**Environment secret は同名の repo secret を自動的に上書き**する。ワークフロー側 (`${{ secrets.CLOUDFLARE_API_TOKEN }}`) は変更不要。

### GitHub Environments の作成

Settings → Environments → **New environment**:

#### Environment `staging` (承認不要、develop push で自動デプロイ。preview もこの環境を使う)
- Secrets (Add secret):

  | Secret | 値 |
  |---|---|
  | `CLOUDFLARE_API_TOKEN` | **staging/preview 専用 token**。Pages:Edit + 対象 staging Worker への権限に絞る (本番 Worker 編集権限は付けない) |
  | `VITE_API_URL` | staging Worker の URL (`https://typedcode-api-staging.<your-subdomain>.workers.dev`) |
  | `VITE_TURNSTILE_SITE_KEY` | staging 用 Turnstile widget の Site Key |

#### Environment `production` (承認ゲート付き、main push でのみ動作)
- Secrets:

  | Secret | 値 |
  |---|---|
  | `CLOUDFLARE_API_TOKEN` | **本番専用 token**。承認ゲート配下なので Approve を経ないと使われない |
  | `VITE_API_URL` | 本番 Worker の URL |
  | `VITE_TURNSTILE_SITE_KEY` | 本番 Turnstile Site Key |

- **Deployment protection rules** → **Required reviewers** を ON にして自分 (またはチーム) を 1 名以上追加
  → これで `main` push 時に Actions タブで Approve を押すまで本番デプロイが保留される
  → 本番 `CLOUDFLARE_API_TOKEN` もこのゲートの内側にあるため、承認なしには使われない

## M3. Cloudflare 側の準備

### Pages プロジェクト作成 (初回のみ)

CI が `wrangler pages deploy --project-name=<name>` で使うプロジェクトが Cloudflare 上に存在する必要があります。

**方法 A: Cloudflare ダッシュボード** (推奨)

1. [https://dash.cloudflare.com](https://dash.cloudflare.com) → Workers & Pages → **Create application** → **Pages** → **Connect to Git** または **Direct Upload**
2. Direct Upload なら名前 (例: `typedcode`) を入力して空のプロジェクトを作成
3. この名前を `CLOUDFLARE_PROJECT_NAME` repo secret として M2 で投入

**方法 B: wrangler CLI**

```bash
npx wrangler pages project create typedcode --production-branch=main
```

確認:
```bash
npx wrangler pages project list
```

### 環境ごとの KV ネームスペース作成

```bash
cd packages/workers
npx wrangler kv namespace create CHECKPOINT_SESSIONS_STAGING
npx wrangler kv namespace create CHECKPOINT_SESSIONS_PRODUCTION
```

出力された 2 つの ID を [packages/workers/wrangler.staging.toml](../packages/workers/wrangler.staging.toml) / [packages/workers/wrangler.production.toml](../packages/workers/wrangler.production.toml) の `id = "..."` に貼り付け commit する (KV ID は秘密情報ではない)。

### Turnstile widget (staging / production 別に作成推奨)

[Turnstile dashboard](https://dash.cloudflare.com/?to=/:account/turnstile) で:

- **staging widget**: Domain に staging Pages URL (例: `develop.typedcode.pages.dev`) を許可
- **production widget**: Domain に本番ドメインを許可

それぞれの **Site Key** を GitHub Environment Secrets (M2 で投入)、**Secret Key** を後で wrangler secret で投入する。

### Worker 個別シークレット投入

Pages bundle の `VITE_API_URL` 等は GitHub Secrets で済みますが、Worker 内で動くシークレット (`TURNSTILE_SECRET_KEY` 等) は **`npx wrangler secret put` で Worker に直接** 投入します。

```bash
cd packages/workers

# staging Worker
npx wrangler secret put TURNSTILE_SECRET_KEY --config wrangler.staging.toml
npx wrangler secret put ATTESTATION_SECRET_KEY --config wrangler.staging.toml      # openssl rand -hex 32
npx wrangler secret put CHECKPOINT_SIGNING_KEY_ID --config wrangler.staging.toml   # M4 で生成
npx wrangler secret put CHECKPOINT_SIGNING_KEY_JWK --config wrangler.staging.toml  # M4 で生成

# production Worker (同じ 4 件、値は別物にする)
npx wrangler secret put TURNSTILE_SECRET_KEY --config wrangler.production.toml
npx wrangler secret put ATTESTATION_SECRET_KEY --config wrangler.production.toml
npx wrangler secret put CHECKPOINT_SIGNING_KEY_ID --config wrangler.production.toml
npx wrangler secret put CHECKPOINT_SIGNING_KEY_JWK --config wrangler.production.toml
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
2. **keyId** と **privateKey JWK** を M3 の `npx wrangler secret put` で対応 Worker に投入
3. commit & push (registry.ts 変更)

## M5. 動作確認

### doctor で全項目チェック

`--maintainer` を付けると **GitHub Actions / staging / production 側のすべて** を一括検査します:

```bash
npm run doctor -- --maintainer
```

検査内容 (M1-M4 で設定した項目を全網羅):

- repo 設定 (`delete_branch_on_merge=false`)
- repo level secrets (`CLOUDFLARE_API_TOKEN`, `ACCOUNT_ID`, `PROJECT_NAME`)
- Environments (`staging`, `production`) の存在
- production の Required reviewers
- 各 environment の secrets (`VITE_API_URL`, `VITE_TURNSTILE_SITE_KEY`)
- `wrangler.staging.toml` / `wrangler.production.toml` の KV ID
- staging / production Worker のデプロイ状態
- 各 Worker の secrets (`TURNSTILE_SECRET_KEY`, `ATTESTATION_SECRET_KEY`, `CHECKPOINT_SIGNING_KEY_ID`, `CHECKPOINT_SIGNING_KEY_JWK`)
- Cloudflare Pages プロジェクトの存在

これですべて ok なら、CI 経由のデプロイがフローします。

### スモークテスト

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
