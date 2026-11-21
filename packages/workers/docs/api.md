# packages/workers — エラーコード・CORS・濫用防止

`/api/checkpoint/sign` のエラーコード、CORS の許可判定 (`ALLOWED_ORIGINS`)、上限と Rate Limiting を触るときに読む。[AGENTS.md](../AGENTS.md) から移した節で、エンドポイントの一覧と不変条件は AGENTS.md にある。

## エラーコード (`/api/checkpoint/sign`)

| Code | HTTP | 意味 |
|---|---|---|
| `SCHEMA_INVALID` | 400 | リクエスト body のスキーマ違反 |
| `TOKEN_REQUIRED` | 401 | `sessionStartToken` 不在 (ADR-0027。KV read より前に弾く) |
| `TOKEN_INVALID` | 401 | token の署名 / registry / 形式が不正 (内部理由はログのみ) |
| `TOKEN_SESSION_MISMATCH` | 401 | `token.payload.sessionId` ≠ `input.sessionId` (token 使い回しで新規 sessionId を連打する手口を塞ぐ) |
| `TOKEN_EXPIRED` | 401 | `token.payload.issuedAt` から `SESSION_TOKEN_MAX_AGE_MS` (30 日) を超えている (#227。KV read より前)。editor は恒久失敗にせず、より新しい token が解決されたら再送する |
| `TAB_LIMIT_EXCEEDED` | 429 | per-session タブ台帳 (`tabs:{sessionId}`) が `MAX_TABS_PER_SESSION` (64) 超過 |
| `NON_MONOTONIC` | 409 | `checkpointIndex` が単調増加していない |
| `CHECKPOINT_CONFLICT` | 409 | 同一 index で内容不一致 (冪等性が成立しない) |
| `SESSION_LIMIT_EXCEEDED` | 429 | KV の `SESSION_MAX_CHECKPOINTS` 超過 |
| `SIGNING_KEY_NOT_CONFIGURED` | 500 | `CHECKPOINT_SIGNING_KEY_*` 未設定 |
| `SIGNING_KEY_UNKNOWN` | 500 | `keyId` がレジストリに存在しない |
| `SIGNING_KEY_MISMATCH` | 500 | env の秘密 JWK がレジストリの同 `keyId` の公開鍵と対ではない (JWK の差し替えミス。署名前に検知) |
| `SIGNING_KEY_INVALID` | 500 | レジストリの署名鍵が現時点で無効 (revoked / 有効期間外 / 日時 parse 不能。`checkRegistryKeyValidityAt`)。`revokedAt` が未来の鍵は警告ログのみで署名する |
| `SIGNING_ERROR` | 500 | 署名計算で予期しない失敗 |
| `SESSION_PERSIST_FAILED` | 503 | **初回** checkpoint の KV 書き込み失敗。`firstSeenAt` が固定されないため署名済み envelope は返さずクライアントにリトライさせる (2 回目以降の書き込み失敗は best-effort で 200) |
| `SESSION_STATE_UNAVAILABLE` | 503 | KV の**読み取り**失敗、または読めた record が不正形 (#297)。「existing = null」と混同すると既存セッションに別の `firstSeenAt` で署名してしまう (#151/#153) ため、署名せずリトライさせる |

`SCHEMA_INVALID` には `sessionId` / `tabId` の文字種違反 (`^[A-Za-z0-9._-]+$` 外。#297) も含む。

## CORS と濫用防止の設計

CORS は `ALLOWED_ORIGINS` (env var, カンマ区切り) による**許可リスト方式**で実装する (`src/index.ts` の `resolveCorsOrigin`)。

許可判定の優先順位 (**fail-closed**):

1. `ALLOWED_ORIGINS` に一致 (**完全一致** or `https://*.domain` の**サブドメイン wildcard**) → その Origin を reflect
2. `ENVIRONMENT === 'development'` のとき `localhost` / `127.0.0.1` → 自動許可 (DX)
3. それ以外 → `Access-Control-Allow-Origin` を**付与しない** (ブラウザのクロスオリジン読み取りを拒否)

ワイルドカード `*` は一切返さない (Origin 不在のリクエストにはヘッダ自体を付けない)。許可オリジンは `wrangler.{production,staging}.toml` の `[vars]` に直接 commit する (公開ドメインでありシークレットではない)。

**fail-closed**: 非 development で `ALLOWED_ORIGINS` が空 / 不一致なら拒否する。以前は未設定時に任意 Origin を reflect する fail-open だったが、staging/production の config に値を commit したため廃止した。**新しい環境を追加するときは `ALLOWED_ORIGINS` の設定が必須** (未設定だとフロントから API を読めない)。

**editor と verify は同一 Pages プロジェクト** (`editor=/`, `verify=/verify`) にデプロイされるため origin は環境ごとに 1 つ。実際の設定:

| 環境 | Worker | `ALLOWED_ORIGINS` | 理由 |
|---|---|---|---|
| production | `typedcode-api` | `https://typedcode.dev,https://typedcode.pages.dev` | カスタムドメイン + 既定 pages.dev |
| staging | `typedcode-api-staging` | `https://*.typedcode.pages.dev` | staging デプロイ (`staging.typedcode.pages.dev`) + PR プレビュー (`<branch>.typedcode.pages.dev`) を許可 |
| dev (local) | (local) | 未設定 | `ENVIRONMENT=development` で localhost 自動許可 |

`*.domain` wildcard は **1 段以上のサブドメインを要求** し (apex は含めない)、先頭リテラルドット要求で `https://eviltypedcode.pages.dev` のような prefix 偽装を弾く。`*.pages.dev` のように広げると他人の Pages サイトまで通るので**自プロジェクト配下に限定**すること (`<branch>.<project>.pages.dev` は自プロジェクトの branch alias に限られる)。新しいカスタムドメイン (例: `www.`) を足すときは production の `ALLOWED_ORIGINS` に追記する。

**CORS の限界と濫用防止**: CORS はブラウザのクロスオリジン**読み取り**のみを制限し、サーバ間アクセス (curl 等) は防げない。`/api/checkpoint/sign` は「任意 content への serverTimestamp 付き署名」を返すだけで、それ自体は何の権限も与えない (署名は『この内容がこのサーバ時刻に提示された』ことしか証明しない)。署名 API の濫用に対する実際の防御線は:

- **per-(sessionId, tabId) 上限** (タブ単位。名前は `SESSION_` だが per-tab): `SESSION_MAX_CHECKPOINTS` (50,000) と `SESSION_TTL_SECONDS` (7 日)。ただし `sessionId`/`tabId` はクライアント任意文字列なので**新規 sessionId を連打されると効かない** (per-key 上限のため)
- **入力サイズ上限**: `MAX_JSON_BODY_BYTES` (8KiB。`src/body.ts`) を**全 POST で読み込み中に強制** (Content-Length は信用せず実バイトで打ち切り、Turnstile fetch・署名・KV に触れる前に 400)。Turnstile トークンは型・非空・`MAX_TURNSTILE_TOKEN_LENGTH` (2048) を検査。スキーマ厳格化 (64-hex / 最大長) も併用
- **IP / グローバル rate limit**: Cloudflare の WAF / Rate Limiting Rules に委譲 (Worker コード外。下記の通り**必ず設定する**)

### Rate Limiting の設定 (#136・defense-in-depth)

**恒久対策は実装済み** (ADR-0027): `/api/checkpoint/sign` は `sessionStartToken` 前提になり、無認証リクエストは KV に触れる前に 401 で棄却される。新規 sessionId の作成コストは Turnstile 1 回に転嫁され、tabId 連打も per-session タブ台帳 (64) で有界。Rate Limiting Rule は **defense-in-depth** として引き続き推奨する (ECDSA 検証そのものの CPU コストと、session/start への負荷を抑える):

1. Cloudflare ダッシュボード → 対象 Worker のゾーン → Security → WAF → Rate limiting rules
2. Rule: `URI Path eq "/api/checkpoint/sign"` かつ method POST に対し、**同一 IP から 60 秒あたり N リクエスト** (署名 API の実利用は 1 セッション数秒〜十数秒に 1 回程度なので N=60 程度から始め、正規利用のログを見て調整) を超えたら `Block` (または `Managed Challenge`)
3. `/api/session/start` にも同様の Rule を推奨 (Turnstile ゲートはあるが署名を伴う)
4. 設定後、正規の連続 checkpoint (長時間セッション) が誤ブロックされないことを staging で確認する

> この Rule は Worker コード外 (ダッシュボード管理) なのでリポジトリに設定証跡が残らない。**新環境 (staging/production) を立てるたびに手動で入れること。** 未設定でも ADR-0027 の token ゲートで KV write 増幅 DoS は成立しないが、署名 API の CPU 消費までは抑えられない。
