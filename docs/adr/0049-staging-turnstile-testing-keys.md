# ADR-0049: staging は Turnstile の公開テストキーで動かし、配信物をブラウザ E2E で通す

- **Status**: Accepted
- **Date**: 2026-11-07
- **Deciders**: @shinyaoguri
- **PR / Commit**: (#660 を閉じる PR。E2E 本体は #655)

## Context

「CI が緑なら手動確認は不要」([ADR-0034](0034-replace-manual-verification-with-automated-tests.md)) は、まだ配信物まで届いていない。E2E (`packages/e2e/`) が相手にするのは dev サーバと手元の本番ビルドだけで、deploy は secrets を入れて build し直す。#579 は deploy 後にヘッダ・署名鍵・CORS を curl で個別に確かめる予定だが、それらが組み合わさって利用者の操作 (打鍵 → 署名付き checkpoint → export → 検証) として通るかは見ない (#655)。

実 URL をブラウザで通すには、session/start と export 前の認証で Turnstile を通る必要がある。headless の Chromium では本物の Turnstile が通るかどうかが走るたびに変わる。通れば署名経路、落ちれば未アンカーの経路を通るので、判定が安定しない。

Cloudflare の公開テストキー (Site Key `1x00000000000000000000AA` / Secret Key `1x0000000000000000000000000000000AA`) は常に通る。ただし siteverify は `{"success":true,"hostname":"example.com","metadata":{"result_with_testing_key":true}}` を返す (2026-11-07 に実測)。staging の Worker は `ALLOWED_ORIGINS = "https://*.typedcode.pages.dev"` を持つので、`isTurnstileHostnameAllowed` がこの hostname を弾く。PR プレビューの build は staging と同じ site key を使う (`deploy.yml` の build-preview。GitHub 環境 `preview` の variable)。

## Considered Options

### Option A: staging (と PR プレビュー) を公開テストキーに替え、Worker は staging でだけ testing key の結果を通す

- Pros: ブラウザでの経路を通しで確かめられる。テストキーでも Turnstile の `api.js` と iframe は本物が読み込まれるので、COEP の下でスクリプトが読み込めるかも確かめられる。production に誤ってテスト secret を入れたときに、Worker が拒否して気付ける
- Cons: staging と PR プレビューで本物の Turnstile を試す場がなくなる。site key の取り違えや widget のドメイン登録漏れは production で初めて分かる

### Option B: staging は本物のまま、Worker に E2E 用の迂回 (GitHub secret と照合するヘッダ) を足す

- Pros: staging で人が本物の Turnstile を試せる
- Cons: E2E は Turnstile のスクリプトを route で差し替えるので、スクリプトの読み込みを確かめない。迂回のコードが production の Worker にも載る (secret の有無で無効化するだけ)

### Option C: Turnstile を通らない経路 (best-effort の export) だけを実 URL で確かめる

- Pros: Worker も鍵も変えない
- Cons: 上の理由で、どちらの経路を通るかが走るたびに変わる。確かめられるのは配信と bundle 程度で、`test:build` とほとんど変わらない

### Option D: 実 URL の E2E は作らない

- Pros: 何も足さない
- Cons: 配信物で確かめるのは #579 の個別の curl だけになる

## Decision

**Option A を採る。production には当てない。**

1. staging の site key (GitHub 環境 `staging` の secret と `preview` の variable) と staging Worker の `TURNSTILE_SECRET_KEY` を公開テストキーにする。手順は [docs/setup.md](../setup.md)
2. Worker (`/api/session/start` と `/api/verify-captcha`) は、siteverify の `metadata.result_with_testing_key` が true のとき:
   - `ENVIRONMENT === 'staging'` → hostname の照合を飛ばして通す
   - `ENVIRONMENT === 'development'` → 従来どおり (手元と E2E の dev サーバ。`ALLOWED_ORIGINS` が無いので照合しない)
   - それ以外 (production・未設定・未知の値) → 拒否する (fail-closed)
3. main push ごとに、deploy した staging の URL に対して round-trip E2E を走らせる (#655)

production に当てない理由: production で通すには、本物の Turnstile の守りを A か B の形で production でも緩めることになる。一方で、staging と production の違いは secrets の値くらいで、それは #579 の `/health` と preflight が見る。

## Consequences

### Positive

- 配信物の上で、Turnstile → session/start → 署名付き checkpoint → export → verify-cli が main push ごとに通しで確かめられる
- production の Worker はテストキーの結果を必ず拒否する。いまは `ALLOWED_ORIGINS` の照合でたまたま弾かれているだけだった

### Negative / Trade-offs

- 本物の Turnstile を通るのは production だけになる。production の site key・widget のドメイン登録・secret の取り違えは、リリース後に初めて分かる
- staging の session/start は事実上誰でも通せる。新しい sessionId を作るコストを Turnstile 1 回に寄せる設計 ([ADR-0027](0027-checkpoint-sign-requires-session-token.md)) は staging では効かない。staging の署名鍵は production と別で、Worker の Rate Limiting Rule は引き続き効く

### Follow-ups / 残課題

- #579: deploy 後の curl による確認 (ヘッダ・署名鍵・CORS)
- production の Turnstile の設定ミスを早く見つける手段は持たない。実害が出たら起票する

## References

- `packages/workers/src/index.ts` の `isTurnstileHostnameAllowed`・`handleVerifyCaptcha`・`handleSessionStart`
- [packages/workers/AGENTS.md](../../packages/workers/AGENTS.md) の不変条件 9
- #655、#660、#579、[ADR-0027](0027-checkpoint-sign-requires-session-token.md)、[ADR-0034](0034-replace-manual-verification-with-automated-tests.md)
- Cloudflare Turnstile のテスト用キー: https://developers.cloudflare.com/turnstile/troubleshooting/testing/
