# ADR-0002: 署名済みチェックポイントは ECDSA-P256 + append-only 鍵レジストリで運用する

- **Status**: Accepted (2026-11-20 に鍵の環境を追補: registry の鍵は環境を持ち、検証器は既定で staging の鍵を時刻証拠に数えない。#321)
- **Date**: 2026-05-28

## Context

ハッシュチェーン + PoSW だけでは、proof ファイル全体を後から作り直して時刻だけ改竄するような攻撃を防げない。**サーバ側で署名と時刻を結びつける必要がある** (時刻アンカリング)。

要件:
- proof ファイル単独で署名検証が完結する (verifier がオフラインでも公開鍵があれば検証可)
- 鍵は失効可能 (compromise 時)
- 過去の proof は鍵失効後も検証可能 (履歴の保護)
- クライアント (editor) ⇔ サーバ (Workers) でのプロトコル簡素
- Workers の制約: Cloudflare Workers の Web Crypto API でサポートされるアルゴリズムに限られる
- 開発者ごとにローカル開発用鍵を生成できる

## Considered Options

### Option A: HMAC-SHA256 (対称鍵)
- Pros: 高速、実装シンプル
- Cons: **verifier が秘密鍵を持つ必要がある** → 検証はクライアントだけで完結しない、信頼境界が崩れる

### Option B: RSA (RSA-PSS, 2048-bit)
- Pros: 広く知られている
- Cons: 鍵サイズが大きい (公開鍵 ~270 bytes)、署名サイズが大きい (256 bytes)、Workers での計算コスト

### Option C: Ed25519
- Pros: 短い鍵/署名、計算が速い、サイドチャネルに強い
- Cons: **Cloudflare Workers の Web Crypto API が長らく未対応** (検討時点)。対応状況の変化を待つことになる

### Option D: ECDSA-P256 (NIST P-256, secp256r1) ← 採用
- Pros: Workers Web Crypto API でネイティブ対応、公開鍵 JWK 形式で `~88 bytes`、署名 64 bytes、検証側ブラウザでもネイティブ対応
- Cons: ECDSA は乱数を漏らすと秘密鍵が露呈する (deterministic ECDSA を使えば緩和されるが、Web Crypto は乱数 ECDSA)

## Decision

**Option D を採用**。アルゴリズムは ECDSA-P256、署名 payload は決定的 JSON (`hashUtils.deterministicStringify`)、鍵は JWK で管理する。

鍵管理:
- **本番鍵**: `packages/shared/src/checkpointKeys/registry.ts` に **append-only** で追加。失効は `status: 'revoked'` で表現し、エントリは削除しない (古い proof の検証用に残す)
- **開発鍵**: `packages/shared/src/checkpointKeys/localKeys.ts` に書き、git の管理から隠す。CI ビルドには含まれない
  - (#338 で gitignore に変更: 当初は空配列のファイルを追跡したうえで `git update-index` のインデックス単位のフラグで隠していたが、worktree 間で共有されず、e2e の setup が書き換えた鍵が誤コミットされる経路が残った。いまは追跡せず、無ければ `npm install` (postinstall) が `localKeys.ts.example` から作る)
- **秘密鍵**: 本番は `wrangler secret put`、開発は `.dev.vars`。git には絶対に入れない
- **発行ツール**: `npm run gen-checkpoint-key -w @typedcode/workers` で公開鍵 / 秘密鍵 / keyId を一括生成
- **鍵の環境 (2026-11-20 追補, [#321](https://github.com/shinyaoguri/typedcode/issues/321))**: registry のエントリは `environment: 'production' | 'staging'` を必ず持つ (localKeys.ts の鍵は読み込む側が常に `development` にする)。当初は staging の鍵も本番の鍵と区別なく `active` で並べていたが、staging は main への push ごとに自動で配信され、PR のプレビューも承認なしで staging の Worker を叩く。staging の鍵が本番と同じ信頼を受けると、本番の時刻保証の強さが「ブランチを push できる人」の範囲まで下がる
  - **検証器**: registry の全鍵で署名を検証した後で、鍵の環境を信頼するかを決める。既定で時刻証拠 (sessionStartToken による root のアンカーと署名 cp) に数えるのは production と development の鍵だけ。staging を数えるのは、verify-cli の `--allow-staging-keys` と、`TYPEDCODE_TRUST_STAGING_KEYS=true` でビルドした verify (staging と PR プレビューの配信) だけ。環境の書かれていないエントリは信頼しない
  - **staging の鍵で署名済みの既存 proof**: 改ざんではないので、整合性と総合の合否 (verify-cli の exit code) は落とさない。時刻の証拠が無い proof と同じ結論にし (temporal を anchored / partial に上げない。受理ポリシーは「無い」として評価する)、staging の鍵であることを理由として表示する。署名そのものが壊れていれば従来どおり失敗。既存の keyId は変えず、鍵のローテーションも前提にしない
  - **Worker**: `/api/checkpoint/sign` は、自分の署名鍵と同じ環境の鍵で発行された token だけを受け付ける (本番の Worker は、staging の Worker が発行した token では署名しない)。本番の Worker の署名鍵が `tcp-202605-fd6d42` であることは、2026-11-20 に本番の `/health` (`environment: production`、`signing.keyId`) で確かめた
  - **却下した案**: staging の証拠を未登録の鍵 (#329) と同じく失敗 (exit 1) にする案。staging の editor の export 後の自己検証と、staging で作った proof の確認が一律に失敗になる。署名を剥がした proof と比べて捏造の余地は増えないので、失敗にする利益が無い
  - **残る穴**: Worker は、自分の `ENVIRONMENT` と署名鍵の環境が合っているかを確かめない (設定の取り違えは検知しない)。`/api/checkpoint/public-keys` は環境を付けて全鍵を返す (自環境の鍵だけには絞っていない)

verifier 側は `/api/checkpoint/public-keys` をキャッシュするか、registry に含まれている鍵をローカルで使う (オフライン検証可)。

## Consequences

### Positive
- 検証はクライアントだけで完結 (HMAC のような信頼境界の課題なし)
- 短い鍵 / 署名サイズで proof のオーバーヘッドが小さい
- 公開鍵を append-only にすることで、過去 proof の検証性が永続化する
- 鍵ローテーション可能 (新鍵を registry に追加、旧鍵で署名された proof は旧鍵で検証)

### Negative / Trade-offs
- ECDSA の乱数依存。Web Crypto の RNG を信頼する必要がある
- `registry.ts` が事実上 append-only リストになる (削除のための仕組みは無い、無効化は `status: 'revoked'`)
- 鍵 ID の命名規約 (`tcp-YYYYMM-xxxxxx`) を守る運用が必要

### Follow-ups / 残課題
- Ed25519 が Workers で安定対応されたら検討余地あり (鍵サイズ・耐量子の議論は別途)
- 量子耐性 (Falcon, Dilithium) は将来課題

## References

- 鍵レジストリ: [`packages/shared/src/checkpointKeys/registry.ts`](../../packages/shared/src/checkpointKeys/registry.ts)
- 署名検証ロジック: [`packages/shared/src/signedCheckpoints.ts`](../../packages/shared/src/signedCheckpoints.ts)
- Workers エンドポイント: [`packages/workers/src/checkpoint.ts`](../../packages/workers/src/checkpoint.ts)
- 鍵生成スクリプト: [`packages/workers/scripts/generate-checkpoint-key.mjs`](../../packages/workers/scripts/generate-checkpoint-key.mjs)
- 関連 ADR: [0003 (idempotent signing)](0003-idempotent-signing-retry.md)
