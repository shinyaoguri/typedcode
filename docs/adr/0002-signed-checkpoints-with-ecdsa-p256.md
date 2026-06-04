# ADR-0002: 署名済みチェックポイントは ECDSA-P256 + append-only 鍵レジストリで運用する

- **Status**: Accepted
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
- **開発鍵**: `packages/shared/src/checkpointKeys/localKeys.ts` に書き、`git update-index --skip-worktree` で隠す。CI ビルドには含まれない
- **秘密鍵**: 本番は `wrangler secret put`、開発は `.dev.vars`。git には絶対に入れない
- **発行ツール**: `npm run gen-checkpoint-key -w @typedcode/workers` で公開鍵 / 秘密鍵 / keyId を一括生成

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
