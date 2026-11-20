# packages/workers — AGENTS.md

`@typedcode/workers` は **Cloudflare Workers の API サーバ**。Turnstile 検証・セッション開始トークンと署名済みチェックポイントの発行を担当する。

このファイルには、毎回読む責務・不変条件・罠だけを置く。理由・例外・表・一覧は [docs/](docs/) にあるので、下の「触る前に読む」で当たる文書を、コードを触る前に読む (置き場の規則は root の [AGENTS.md](../../AGENTS.md)「ドキュメント階層」)。

## 責務と境界

- **持つ**: Turnstile API への HTTP 検証、ECDSA-P256 でのセッション開始トークン・cp 署名、KV を使った per-session のリプレイ防止と冪等処理
- **持たない (#415 でやめた)**: export 前アテステーションの署名。`/api/verify-captcha` は Turnstile の結果を `signature: 'unsigned'` で返す (形は旧 editor との互換のために残す)。署名用の secret も持たない
- **持たない**: ハッシュチェーン計算 (shared に委譲)、proof の保管 (Workers は stateful な保管庫ではない)、ユーザー個別ストレージ

## 触る前に読む

| 触るもの | 先に読む |
|---|---|
| `/api/checkpoint/sign` のエラーコード、CORS (`ALLOWED_ORIGINS`)、per-session の上限、Rate Limiting | [docs/api.md](docs/api.md) |
| KV のキー・record の形・タブ台帳、容量の見積もり、KV が枯渇したときの挙動 | [docs/kv.md](docs/kv.md) |
| `wrangler*.toml`・シークレットの宣言・`Env` の型、ローカルの立ち上げ、デプロイ環境と GitHub Environments | [docs/operations.md](docs/operations.md) |

## 重要な不変条件

1. **`/api/checkpoint/sign` は冪等** ([docs/adr/0003-idempotent-signing-retry.md](../../docs/adr/0003-idempotent-signing-retry.md)): 同一 `sessionId` / `checkpointIndex` で `clientTimestamp` 以外が一致するリクエストには **前回 envelope をそのまま返す**。`isIdempotentSigningRetry` で判定。これがないとネットワーク再送で `previousSignedCheckpointHash` チェーンが破綻する
2. **`CHECKPOINT_SIGNING_KEY_*` シークレット**: 本番では `wrangler secret put` で投入。秘密鍵を git に入れない
3. **公開鍵レジストリは append-only**: `packages/shared/src/checkpointKeys/registry.ts`。失効は `status: 'revoked'` で表現し、削除しない。**鍵のローテは必ず `keyId` の変更を伴う**: `getSigningKey` は署名のたびにレジストリの公開鍵と env の秘密 JWK が対であること (`SIGNING_KEY_MISMATCH`) と、その鍵が今有効であること (`SIGNING_KEY_INVALID`) を確かめるので、同一 `keyId` のまま JWK だけを差し替えると 500 になる。キャッシュは `keyId` と JWK 文字列の**両方**が一致したときだけ再利用する (#285)
4. **KV は eventually consistent**: 同一 key への高頻度書き込みは ~1 write/sec の制限あり。cp トリガが頻発しないよう shared 側がハイブリッドトリガを使う ([docs/adr/0001-hybrid-checkpoint-trigger.md](../../docs/adr/0001-hybrid-checkpoint-trigger.md))
5. **CORS のオリジン**: 編集 / 検証アプリのドメインを許可。ワイルドカード禁止 ([docs/api.md](docs/api.md)「CORS と濫用防止の設計」参照)
6. **`sessionId` は信用しない**: クライアントが投げる任意の文字列。サーバ側で `firstSeenAt` を KV に保存し改ざんを防ぐ
7. **`/api/checkpoint/sign` は `sessionStartToken` 前提** (ADR-0027): token 検証は KV read より**前**に行い、無認証リクエストに KV コストを払わない。sessionId は token に束縛され、新規 sessionId の作成コスト = Turnstile 1 回になる。exam は署名専用 token を editor が best-effort 取得する (root には焼かない)。**token の最大有効期間 `SESSION_TOKEN_MAX_AGE_MS` (30 日) は sign 経路 (`checkpoint.ts`) だけで検査し、検証器 (`verifySessionStartToken`) は age を見ない** (#227): 検証器も同じ関数を呼ぶので、そこに入れると過去の proof の採点が壊れる。無期限だと KV TTL (7 日) ごとに `signedCount` とタブ台帳がリセットされ続けるのを有界化する。未来の `issuedAt` は弾かない (作れるのは署名鍵を持つ者だけで、その者は sign を経由しなくてよい)
8. **`serverTimestamp` は同一 record 内で厳密増加させる** (#226): 検証器は連続する署名 cp の `serverTimestamp` に厳密増加を要求するので、`clampServerTimestamp` が署名前に `max(now, lastServerTimestamp + 1ms)` へクランプし、その値で署名・保存する (発動時は `console.warn`、sessionId は出さない)。既に読んだ record を使うので KV の読み書きは増やさない。限界: KV は結果整合なので、別コロで record が stale に見える窓や、put が 429 で落ちた直後は塞げない (そこは検証器側の許容 = 別件)。冪等再送は前回 envelope を返すので対象外
9. **Turnstile の公開テストキーの結果は staging でだけ通す** ([ADR-0049](../../docs/adr/0049-staging-turnstile-testing-keys.md)、#660): staging と PR プレビューは Cloudflare の公開テストキーで動き (main push ごとに staging の実 URL をブラウザ E2E で通すため)、その siteverify は `hostname: "example.com"` と `metadata.result_with_testing_key: true` を返す。`/api/session/start` と `/api/verify-captcha` は、`ENVIRONMENT === 'staging'` のときだけ testing key の結果で hostname の照合を飛ばす。`development` は従来どおり、**それ以外 (production・未設定・未知の値) では testing key の結果を拒否する** (fail-closed。production に誤ってテスト secret を入れると session/start が通らなくなって気付ける)
10. **Worker は 1 つ前のリリースの editor / verify と組み合わせても動く** (#656): deploy は Workers → Pages の順 (`.github/workflows/deploy.yml` の deploy-staging / deploy-production)。Pages の deploy が落ちたとき、Pages だけを戻したとき ([CONTRIBUTING.md「本番を戻す」](../../CONTRIBUTING.md#本番を戻す-ロールバック))、配信が切り替わるまでの間は「新しい Worker + 1 つ前の editor / verify」で動く。だからエンドポイントの削除、リクエストの必須項目の追加、応答の形を変えるといった非互換な変更は、editor / verify がそれを使わなくなったリリースの**次の**リリースで行う (`/api/verify-captcha` の形を残しているのはこの例)。逆の「1 つ前の Worker + 新しい editor / verify」は保証しない。Worker だけを戻すときは、ロールバック手順の側でそのリリースの依存を確かめる
11. **token の鍵は署名鍵と同じ環境に限る** (#321 / ADR-0002): `handleSignCheckpoint` は token の検証の直後 (KV read より前) に、token の鍵と `CHECKPOINT_SIGNING_KEY_ID` の registry のエントリの `environment` を比べ、違えば (どちらかに環境が無くても) 401 `TOKEN_INVALID` を返す (理由はログだけ)。署名鍵が registry に無いときは判定せず、`getSigningKey` の 500 に任せる。Worker の `ENVIRONMENT` と署名鍵の環境の一致は見ていない (staging の署名鍵は `tcp-202606-0e46c9` で `deployed.spec.ts` が固定、本番は `tcp-202605-fd6d42` で `/health` の `signing.keyId` から読める)。`/api/checkpoint/public-keys` は各鍵の `environment` を付けて返す

## ファイル構成

```
src/
├── index.ts        # エントリ:
│                   #   - ルーティング、CORS、セキュリティヘッダ (withSecurityHeaders)
│                   #   - Turnstile 検証 (+ 署名しない export 前アテステーション)
│                   #   - セッション開始トークン発行 (handleSessionStart)
│                   #   - ヘルスチェック
├── body.ts         # 本文 JSON の上限付き読み取り (readJsonBodyLimited)。全 POST が通る
└── checkpoint.ts   # 署名済み cp:
                    #   - handleSignCheckpoint (POST /api/checkpoint/sign)
                    #   - handlePublicKeys (GET /api/checkpoint/public-keys)
                    #   - 冪等チェック、KV セッション管理
                    #   - ECDSA-P256 鍵のロード
```

## エンドポイント

| Endpoint | Method | 用途 |
|---|---|---|
| `/api/verify-captcha` | POST | Turnstile トークン検証 + 署名しないアテステーション (`signature: 'unsigned'`。#415) を返す (ADR-0017 で **作成時 #0 経路は session/start に統合**。pre-export 等で残置) |
| `/api/session/start` | POST | **ADR-0017**: Turnstile 検証 → `serverNonce` 入り ECDSA-P256 署名トークンを発行。クライアントは serverNonce を chain root に焼く。署名鍵は checkpoint と同一系統 (`getSigningKey`) |
| `/api/checkpoint/sign` | POST | 未署名 cp に ECDSA-P256 署名 + `serverTimestamp` 付与。**`sessionStartToken` 前提** (ADR-0027: body に同送された token を registry で検証し `sessionId` 一致を要求) |
| `/api/checkpoint/public-keys` | GET | 公開鍵レジストリ取得 (検証側のキャッシュ用) |
| `/health` | GET | ヘルスチェック。dev (`npm run dev` の `--var DEV_WORKTREE_ID`) では作業ツリーの識別子 `worktree` も返す (e2e の照合用。#552)。署名鍵の readiness は [README の `/health`](README.md#get-health) を参照 |

`/api/session/start` (ADR-0017) は **Turnstile ゲート + root アンカー + 人間ゲート**を 1 リクエストで兼ねる。`handleSessionStart` (`src/index.ts`) が `verifyTurnstile` + hostname 照合 → `getSigningKey` (checkpoint.ts から export、鍵流用) で `createSessionStartToken` を署名発行。**KV を使わない** (ステートレス・冪等不要)。入力検証は shared の `validateSessionStartInput` (sessionId / fingerprintHash)。トークン検証 (registry-only) は shared の `verifySessionStartToken`。

## よくある罠

- **`.dev.vars` を git に入れない**: `.gitignore` に登録済み。`wrangler.toml` の KV ID は skip-worktree で隠す
- **`compatibility_date` を勝手に動かさない**: 後方互換性のために固定。新機能のために動かす必要があるときは ADR を書く
- **環境ごとの KV ID 分離**: 3 ファイル方式。dev は `wrangler.toml` (skip-worktree)、staging / production は `wrangler.staging.toml` / `wrangler.production.toml` に直接 commit。旧 `[env.production]` ブロック方式は廃止済み (#152)
- **dev の Worker 名は `typedcode-api-dev`**: 本番と同名にすると素の `npx wrangler deploy` が本番を dev 設定で上書きする (#152)。ローカルの skip-worktree 版 `wrangler.toml` も `typedcode-api-dev` に揃えること
- **`gen-checkpoint-key` で出る秘密鍵は JWK の JSON 文字列**: `.dev.vars` に貼るときは改行を含めず 1 行に
