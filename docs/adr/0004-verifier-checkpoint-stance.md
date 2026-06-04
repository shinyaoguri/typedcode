# ADR-0004: 検証側は未署名 cp の sampling を成功条件にしない

- **Status**: Accepted
- **Date**: 2026-04-29
- **PR / Commit**: PR #60 (Harden proof verification)

## Context

過去の verifier は以下のような「楽観的」検証を許していた:
- チェックポイントが N 個あり、ランダムに M セグメントだけ verify して全部 OK なら "verified"
- cp が `CHECKPOINT_INTERVAL` の倍数位置にあることを前提に動いていた
- proof 内部の `metadata.isPureTyping` をそのまま信頼していた

これは攻撃面を広げる:
1. cp を細工してサンプリングを通過させる
2. cp 間隔を仮定するとアルゴリズム変更時に過去 proof が壊れる (cp 数や位置が変わると今の検証ロジックが破綻)
3. proof 内のメタデータを信用するとイベント列を改竄してメタデータだけ書き換えられる
4. PoSW 反復数を proof 内から読んで検証すると、proof 側で反復数を下げて偽造できる

## Considered Options

### Option A: 現状維持 (cp sampling 成功 = verified、cp 間隔を仮定)
- Pros: 検証高速
- Cons: 上記のセキュリティ問題

### Option B: cp を一切無視してフルチェーン検証のみ
- Pros: シンプル、攻撃面最小
- Cons: 大規模 proof で遅い、署名済み cp による時刻アンカリングを活用できない

### Option C: cp は補助情報、検証は別経路 ← 採用
- Pros: cp 数 / 間隔の変化に頑健、署名済み cp は時刻アンカリングに使う、unsigned cp は表示用メタデータ程度に扱う
- Cons: 実装が増える、サンプリング検証は将来課題として保留

## Decision

**Option C を採用**。以下のハードニングを行う:

1. **チェーンルートを fingerprint 由来の nonce にバインド**: 最初のイベントの `previousHash` を信用せず、`fingerprint hash + initialHashNonce` から再計算する
2. **コンテンツリプレイ検証**: `proof.finalContentHash` を信用せず、イベント列から最終コンテンツを再現してハッシュ比較
3. **cp は補助メタデータ扱い**: 未署名 cp の sampling は成功条件にしない。署名済み cp の連結ハッシュは別経路で検証
4. **PoSW 反復数を必須化**: 検証側で `POSW_ITERATIONS = 10000` を期待し、proof 側の値は使わない
5. **ピュアタイピング / メタデータをイベント列から再計算**: `proof.metadata.isPureTyping` を信用せず、イベント列を歩いて再判定する。バルク insertText (1 イベントで複数文字挿入) も検出
6. **cp 間隔を仮定しない**: 検証ロジックのどこにも `CHECKPOINT_INTERVAL` の値を hard-code しない

## Consequences

### Positive
- 攻撃面が大幅に縮小: proof 内部のメタデータ改竄が効かない
- ADR-0001 のハイブリッド cp トリガが既存 proof を壊さない (cp 間隔を仮定しないため)
- 将来アルゴリズム変更 (反復数増、cp 戦略変更) でも検証側の互換性破壊が局所化

### Negative / Trade-offs
- フルチェーン検証は O(n) で、大規模 proof (10 万イベント超) では時間がかかる
- サンプリング検証の高速化が当面使えない (将来、署名済み cp ベースのサンプリングは検討余地あり)
- 検証コードの複雑性が増えた

### Follow-ups / 残課題
- 署名済み cp ベースのサンプリング検証 (verifiable random sampling) は将来検討
- バルク insertText 検出の閾値調整 (現状: 複数文字を 1 イベントで挿入は怪しいとマーク)

## References

- 検証エンジン: [`packages/verify/src/core/VerificationEngine.ts`](../../packages/verify/src/core/VerificationEngine.ts)
- shared 検証ロジック: [`packages/shared/src/verification.ts`](../../packages/shared/src/verification.ts)
- ChainVerifier: [`packages/shared/src/typingProof/ChainVerifier.ts`](../../packages/shared/src/typingProof/ChainVerifier.ts)
- PR #60 (Harden proof verification)
- 関連 ADR: [0001 (cp トリガ)](0001-hybrid-checkpoint-trigger.md), [0002 (署名)](0002-signed-checkpoints-with-ecdsa-p256.md)
