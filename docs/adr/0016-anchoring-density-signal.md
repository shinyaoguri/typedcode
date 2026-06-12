# ADR-0016: 署名チェックポイントの「アンカー密度」をシグナル化し、任意で gate する

- **Status**: Accepted
- **Date**: 2026-06-12
- **Deciders**: develop レビュー (Phase 7 / ADR-B)
- **PR / Commit**: `feat/phase7-anchoring-density` (Phase 7 の最初の一手)

## Context

署名済みチェックポイント (ADR-0002) は proof 唯一の **偽造不能な時刻アンカー**である。現状の検証器は
`anchored = (署名 cp が 1 個以上)` という二値しか見ていない。これは次の偏りを見逃す:

- **末尾 1 個アンカー**: 長いチェーンの最後の event にだけ署名 cp を打つと、`coverage.coverageRatio` は
  最大 1.0、`temporal.postHocSuspected` も false になり、「100% アンカー済み」に見える。しかし実際に
  サーバが時刻を保証しているのは末尾 1 点だけで、その手前の全イベントは**オフラインで捏造**できる
  (root も client 選択なので、PoSW を流して 1 点だけ署名を取れば成立してしまう)。
- **先頭 1 個アンカー**: 逆に開始時の 1 点だけ署名し、以降を捏造する形。

`coverageRatio` (= 最終署名 cp の eventIndex / 全 event 数) は末尾 1 点で最大化されるため、この攻撃に
無力である。「署名 cp の **数 / 間隔** が、主張したイベント数・経過時間に対して妥当か」を誰も見ていない。

注意: ADR-0004「検証側は未署名 cp の sampling を成功条件にしない」は **未署名 cp** に関する方針で、
ここで扱う **署名 cp の密度**とは別軸である。署名 cp はサーバ署名つきの事実なので、その「間隔」を
検証材料にしても ADR-0004 と矛盾しない (未署名 cp の間隔は引き続き仮定しない)。

## Considered Options

### Option A: coverageRatio に絶対下限を設ける (例 `coverageRatio < 0.5` を疑う)
- Pros: 実装が最小。
- Cons: **頭の攻撃を全く防げない** (末尾 1 点で coverageRatio=1.0)。かつ短い正規セッション
  (cp が末尾付近に偏る) を誤検知する。指標として筋が悪い。

### Option B (採用): eventIndex / serverTimestamp の**ギャップ**を密度メトリクスにする
- 署名 cp が指す eventIndex 列の **最大ギャップ** (先頭=event0 境界 / 連続間 / 末尾=最終 event 境界 を含む) と、
  serverTimestamp の最大ギャップ、最初のアンカーまでの遅延 (events) を計量する。
- 末尾 1 点 → 先頭ギャップ大、先頭 1 点 → 末尾ギャップ大、で**どちらの偏りも検出**できる。
- 閾値は CheckpointManager のハイブリッドトリガ (100 events OR 10,000 ms, ADR-0001) の **5 倍**
  (500 events / 50s) という保守的な置き。正規セッションは時間トリガにより最大 ~10s 間隔で署名 cp が
  打たれるはずなので、5 倍未満は正規の signing 失敗 (瞬断) と区別しにくく罰さない。
- 既定は **warning のみ** (valid は true)、`requireAnchorDensity` で **strict-fail** に切替 (exam/採点で opt-in)。
- Pros: 攻撃の核心を突く / 非破壊 (検証器のみ・proof フォーマット不変) / 採点者が強度を選べる。
- Cons: 実ログが無い現状、閾値は安全側の**推測**。offline で本当に signing が間引かれた正規セッションに
  warning が出る (ただしそれは実際に「アンカーが薄い」ので advisory として正直)。

### Option C: 署名時にサーバが cp の最小本数 / cadence を強制する
- Pros: クライアントに依存しない。
- Cons: サーバは stateless な best-effort (ADR-0003)。教室の不安定網で開始/継続をブロックすると
  可用性を壊す。**既存 proof に遡及適用できない**。検証は本来クライアント側で完結すべき (verify は読み取り専用)。

## Decision

**Option B**。検証器に「アンカー密度」メトリクス (`SignedCheckpointsVerificationResult.density`) を追加し、
保守的閾値で `sparse` を立てる。既定は warning (UI/CLI が表示)、`requireAnchorDensity` opt-in で
`valid=false` に落とす。閾値はトリガの 5 倍に置き、`// TODO tune with real logs` を明記する。

サーバ側は変更しない (Option C を採らない)。proof フォーマットも変更しない (加算的シグナル)。

## Consequences

### Positive
- 末尾 1 点 / 先頭 1 点 / 2 点だけ、のような**薄いアンカー**を coverage/postHoc と独立に検出できる。
- 非破壊: 旧 proof もそのまま検証でき、`density` が増えるだけ。フォーマット bump 不要。
- 採点者は `--require-anchor-density` (CLI) で「密なアンカーを必須」にできる。casual は advisory のまま。

### Negative / Trade-offs
- 閾値はサンプルログが無い現状の**保守的な推測**。緩すぎ/厳しすぎは実ログで要調整。
- `firstAnchorLatencyServerMs` は現アーキでは構造的に ~0 (最初の署名 cp の serverTimestamp が
  firstSeenAt と一致するため)。session/start アンカー (ADR-0017) 導入後に「開始→初アンカー遅延」として
  意味を持つ。現状は計測のみで gate には使わない (gate は event ベース指標が主)。
- **正直な天井**: 密度 gate は「末尾 1 点で長い捏造チェーンをアンカー」する経済性を壊し、攻撃者に
  「主張した時間ぶん、実際にサーバへ周期的に接続し続ける」ことを強制するだけである。**実時間で
  サーバ通信しながら合成入力を流すライブ台本セッション**は引き続き valid な proof を作れる。これは
  クライアント暗号の限界で、proctor + 挙動分析の領域。README/spec はこの範囲を超えて主張しないこと。

### Follow-ups / 残課題
- 実セッションログを集め `MAX_ANCHOR_GAP_EVENTS` / `MAX_ANCHOR_GAP_SERVER_MS` / `MAX_FIRST_ANCHOR_LATENCY_EVENTS` を調整。
- verify(web) は現状 density を **warning 表示のみ**。exam proof に対する web 側 strict-fail の配線は follow-up。
- ADR-0017 (session/start サーバアンカー) 実装後、`firstAnchorLatencyServerMs` を gate 対象に格上げ検討。

## References

- 実装: [`packages/shared/src/signedCheckpoints.ts`](../../packages/shared/src/signedCheckpoints.ts) `computeDensity` / `verifySignedCheckpoints` (`requireAnchorDensity`)
- 型: [`packages/shared/src/types/signedCheckpoint.ts`](../../packages/shared/src/types/signedCheckpoint.ts) `SignedCheckpointsVerificationResult.density`
- 配線: [`packages/shared/src/verification.ts`](../../packages/shared/src/verification.ts) `VerifyProofFileOptions.requireAnchorDensity`、verify-cli `--require-anchor-density`
- 関連 ADR: [ADR-0001](0001-hybrid-checkpoint-trigger.md) (cadence) / [ADR-0002](0002-signed-checkpoints-with-ecdsa-p256.md) (署名 cp) / [ADR-0004](0004-verifier-checkpoint-stance.md) (未署名 cp の扱い)
- テスト: [`packages/shared/src/__tests__/signedCheckpoints.test.ts`](../../packages/shared/src/__tests__/signedCheckpoints.test.ts) `anchoring density gate (ADR-0016)`
