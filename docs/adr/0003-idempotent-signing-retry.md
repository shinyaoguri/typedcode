# ADR-0003: 署名 API は内容ベースの冪等性で再送を吸収する

- **Status**: Accepted
- **Date**: 2026-05-28

## Context

実運用 (試験中のユーザー) でハッシュチェーンが破綻するインシデントが発生した:

```
Signed checkpoint previousSignedCheckpointHash does not chain at event 131
```

根本原因:
1. クライアント (editor) の `SignedCheckpointService.flush()` が **並列に複数回呼ばれる** ことがあった
2. 同一 cp に対して 2 つの sign 要求がほぼ同時に Workers に届く
3. Workers が両方に新しい署名を返すと、それぞれの envelope の `previousSignedCheckpointHash` がズレ、後続 cp の鎖が破綻する
4. KV は eventually consistent なため、サーバ側だけで完全な逐次化は保証できない

ネットワーク不安定な試験会場で proof が信用できなくなるのは致命的。**二重防御** が必要。

## Considered Options

### Option A: クライアントだけで単一フライト化
- Pros: シンプル
- Cons: クライアントバグや別タブ動作で並列発火する可能性を排除しきれない、ネットワーク再送 (タイムアウト → 再送) を吸収できない

### Option B: サーバ側で sessionId/checkpointIndex 単位のロック (KV)
- Pros: グローバルに逐次化
- Cons: KV は eventually consistent でロックには向かない、Durable Object などを導入すると複雑性が増す

### Option C: クライアント単一フライト + サーバ内容ベース冪等 ← 採用
- Pros: 二重防御。クライアント側で正常系を逐次化、サーバ側でネットワーク再送・万一の並列を吸収。Durable Object 不要
- Cons: 「同一内容」の判定基準を厳密に決める必要がある

## Decision

**Option C を採用**。両層で防御する。

### クライアント側 (editor)
- `SignedCheckpointService` を **single-flight** にする (`flushing` フラグ + drain-while-loop)
- 同時に 1 つの sign リクエストしか送らない
- キューに溜まった cp は `min(queue.keys())` から順次フラッシュ

### サーバ側 (workers)
- `isIdempotentSigningRetry(input, cached)` で判定
- 直前 envelope を KV (`lastEnvelope`) に保存
- 新リクエストが **`clientTimestamp` を除いて完全一致** なら、前回の envelope をそのまま返す
- `clientTimestamp` を除外する理由: ネットワーク再送ではこの値だけが変わるので、再送と本物の新リクエストを区別できる
- 同 `checkpointIndex` で内容が違うリクエストは `CHECKPOINT_CONFLICT` (409) を返す

## Consequences

### Positive
- ネットワーク不安定でもチェーン破綻なし (再送は冪等)
- クライアントバグや別タブからの並列発火が来てもサーバが守る
- 後付けの破壊的変更なし (既存 proof と互換)
- 試験会場のような長時間・不安定環境で安心

### Negative / Trade-offs
- サーバ側に `lastEnvelope` の KV 保存が増えた (per session)
- `isIdempotentSigningRetry` の判定基準を変えるときは慎重に
- `clientTimestamp` を除外するため、リクエスト時刻の証拠としては使えない (`serverTimestamp` が真実)

### Follow-ups / 残課題
- KV の lastEnvelope サイズが大きくなる場合は別バインディングに分離検討
- メトリクス: 冪等 hit 率を観測できると運用上の知見になる

## References

- クライアント: [`packages/editor/src/services/SignedCheckpointService.ts`](../../packages/editor/src/services/SignedCheckpointService.ts)
- サーバ: [`packages/workers/src/checkpoint.ts`](../../packages/workers/src/checkpoint.ts)
- 判定関数: [`packages/shared/src/signedCheckpoints.ts:isIdempotentSigningRetry`](../../packages/shared/src/signedCheckpoints.ts)
- 関連 ADR: [0001 (cp トリガ)](0001-hybrid-checkpoint-trigger.md), [0002 (署名)](0002-signed-checkpoints-with-ecdsa-p256.md)
