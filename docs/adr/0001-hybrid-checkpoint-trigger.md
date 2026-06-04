# ADR-0001: チェックポイントトリガをハイブリッド (events OR elapsed time) にする

- **Status**: Accepted
- **Date**: 2026-05-30
- **PR / Commit**: cdf47db

## Context

`CheckpointManager` は当初、33 イベントごとに固定 (`(eventIndex + 1) % 33 === 0`) でチェックポイント (cp) を作っていた。各 cp は `POST /api/checkpoint/sign` を 1 回発火するため、Cloudflare KV の per-key write 制限 (~1 write/sec) に近づきうる。

具体的な数値:
- 高速タイピスト: 約 24 events/sec → 約 1.4 秒ごとに cp → **約 0.7 sign req/sec/user**
- 100 ユーザー × 1 時間試験で約 91k cp、約 200 req/sec ピーク
- 1 人あたり proof ファイル ~2 MB

一方、cp 密度はセキュリティ上の本質ではない。改ざん耐性の中核 (ハッシュチェーン整合性、`serverTimestamp` アンカリング、post-hoc temporal ratio、コンテンツ/チェーンハッシュバインディング) は cp 密度に依存しない。「直前 cp と次 cp の窓内でイベント時刻を偽造する」攻撃は、現実的な脅威モデルではない。

## Considered Options

### Option A: 現状維持 (33 イベント固定)
- Pros: シンプル、純粋関数、状態を持たない
- Cons: 高頻度 sign 要求、KV 書き込み上限に近づく、無入力時にも長い未アンカー窓が出る (タイピング速度依存)

### Option B: 固定間隔を伸ばす (例: 100 イベント)
- Pros: シンプルさ維持、sign 要求を 1/3 に削減
- Cons: 無入力時の未アンカー時間がさらに伸びる (低速入力で >10s)

### Option C: 時間トリガのみ (例: 5 秒ごと)
- Pros: 時間境界が一定
- Cons: タイピング中の cp 数が予測不能 (爆発する可能性)、`setInterval` の管理コストとアイドル時の空打ち

### Option D: ハイブリッド (events OR elapsed time、先に達した方で発火) ← 採用
- Pros: 上限 (1/3 の cp 数、10 秒の未アンカー窓) が両側に効く、`recordEvent` 時のみ評価する純粋イベントドリブン (アイドル時は何もしない)、復元・テストの注入も容易
- Cons: ステートフルになる (純粋関数ではなくなる)、`cleanupForExport` の再設計が必要

## Decision

**Option D を採用**。デフォルトは N = 100 イベント、T = 10 000 ms (10 秒)。両方とも `CheckpointManagerOptions` で上書き可能とし、`Date.now` も注入可能にしてテスト容易性を確保する。

時間トリガは **`recordEvent` 呼び出し時のみ** 評価する (wall-clock timer は使わない)。アイドル時に cp は作られないが、最終 cp は `exportProof` 時に強制発火するためカバレッジは保たれる。

## Consequences

### Positive
- 100 ユーザー × 1 時間試験で cp 数とプルーフサイズが約 1/3 に
- 未アンカー窓は 10 秒上限 (低速入力でも保証)
- 既存の proof は無修正で検証可能 (verifier が cp 間隔を仮定しないため、ADR-0004 参照)
- 設定が `CheckpointManagerOptions` 経由で外部から変えられる
- `now: () => number` の注入によりテストが決定的

### Negative / Trade-offs
- `CheckpointManager` がステートフルになった (`lastCheckpointEventIndex`, `lastCheckpointAt`)
- `setCheckpoints` で復元するときに状態を再構築する必要がある (`lastCheckpointAt` は復元時の `now()` を採用)
- 復元時、サーバ時刻ではなくクライアント時刻を採用するため、リストア直後の時間トリガはやや楽観的になる
- `cleanupForExport` の filter (modulo) を捨てて dedupe に変えた。元の防御意図は保たれる

### Follow-ups / 残課題
- 将来、シーン別チューニング (N/T を環境変数や試験ごとに変える) が必要になったら `CheckpointManagerOptions` を経由して注入

## References

- 実装: [`packages/shared/src/typingProof/CheckpointManager.ts`](../../packages/shared/src/typingProof/CheckpointManager.ts)
- テスト: [`packages/shared/src/__tests__/checkpointTrigger.test.ts`](../../packages/shared/src/__tests__/checkpointTrigger.test.ts)
- 仕様: [`docs/system-spec.md`](../system-spec.md) §4.5
- 関連 ADR: [0004 (verifier checkpoint stance)](0004-verifier-checkpoint-stance.md)
- `CheckpointManager.CHECKPOINT_INTERVAL` は `DEFAULT_MAX_EVENTS_PER_CHECKPOINT` の deprecated alias として残す (後方互換)
