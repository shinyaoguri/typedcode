# ADR-0043: 受理ポリシーを検証の結論から分け、違反を構造化して返す

- **Status**: Accepted
- **Date**: 2026-11-04
- **Deciders**: @shinyaoguri
- **PR / Commit**: (#296 を閉じる PR)

## Context

採点者が「この授業ではどこまでの時刻証拠を求めるか」を指定する手段は、ADR-0016 の `requireAnchorDensity` (署名 cp の密度) と ADR-0017 の `requireRootAnchor` (root のサーバアンカー) の 2 つだった。これには 2 つの問題があった ([#296](https://github.com/shinyaoguri/typedcode/issues/296))。

1. **表現力が足りない**: 密度 gate は署名 cp が 0 件なら `density: null` で対象外になる (誤検知を避ける ADR-0016 の仕様)。このため「署名 cp は必ず要る」「最終イベントまで署名が要る」(#295 の `coverage.terminalAnchored`) を受理条件にできなかった。cp を全部消した proof は、2 つの gate を立てても `valid: true` になった。
2. **整合性の失敗と見分けがつかない**: 密度 gate は `verifySignedCheckpoints` の中で `signedCheckpoints.valid` を false にしていた。root gate は `verifyProofFile` の `valid` / `errorMessage` の連鎖に入っていた。どちらも結果の上では改ざん・署名不正と同じ形に畳まれた。「改ざんされた」と「この授業の要求水準に届かない」を、機械的に分けられなかった。

2026-09-09 の要件更新 (#300) で、「不受理」は**要求された証拠水準を満たさないという検証結果**のことであり、ファイルの受領・保存・救出を拒否する意味ではない、と確定している。通信障害や署名の欠落だけで自動失格にしない、厳格化は採点者の opt-in に限る、という条件も付いた。

## Considered Options

### Option A: 既存の 2 フラグの横に個別の gate を足す (`valid` に畳む)
- Pros: 差分が最小。
- Cons: 問題 2 が残る。gate が増えるたびに `errorMessage` の連鎖が伸び、どの層で落ちたかを出力側が推測することになる。

### Option B: 受理ポリシーを独立した評価にし、`integrityValid` と `policy.violations` を分けて返す
- Pros: 「整合性 (改ざん・署名不正)」と「証拠水準の不足」が別のフィールドになる。違反は列挙型の code で、CLI・JSON・将来の採点基盤が同じ値を読める。既存の 2 gate も同じ形に寄せられる。
- Cons: 密度 gate の置き場が変わるので、`--require-anchor-density` を付けたときの表示が変わる (下記)。

### Option C: 名前付きプロファイル (`--policy class-strict`) から入る
- Pros: 授業ごとの設定を 1 語で渡せる。
- Cons: フラグの組を名前で束ねるだけなので、個別の要件が先に要る。需要もまだ示されていない (AGENTS.md「新しい仕組みは実害を示せるときだけ足す」)。

## Decision

**Option B** を採る。プロファイル (Option C) は需要が出たら個別フラグの上に足す。

1. shared に `acceptancePolicy.ts` を置く。`AcceptancePolicy` は 4 つの opt-in 要件を持つ。
   - `requireRootAnchor` (ADR-0017)
   - `requireAnchorDensity` (ADR-0016)
   - `requireSignedCheckpoints`
   - `requireTerminalAnchor`

   `evaluateAcceptancePolicy` は、検証済みの証拠 (`rootAnchored`・exam 束縛の検証結果・`SignedCheckpointsVerificationResult`) から違反を列挙する純関数。code は次の 4 つ。
   - `root-anchor-missing`
   - `anchor-density-sparse`
   - `signed-checkpoints-missing`
   - `terminal-anchor-missing` (未署名の末尾のイベント数を添える)
2. `verifyProofFile` は `integrityValid` と `policy: { applied, evaluated, violations }` を返す。`valid = integrityValid && violations.length === 0` なので、exit code の意味は変わらない。
   - `integrityValid` は「ポリシーを何も足さないときの結論」。version・metadata・chain・token の検証失敗 (#329)・署名 cp の不正・token と cp の sessionId 不一致を含む。ADR-0020 の整合性層 (`assurance.integrity`) や、Tier A バンドルの `integrityValid` (ADR-0024 / #219 の `toBundleIntegrityValid`) とは別の値である。
3. **整合性が落ちた proof ではポリシーを評価しない** (`evaluated: false`、violations は空)。改ざんされた proof の値で「末尾が何件未署名か」を語らないためである。「違反なし」と「評価していない」は `evaluated` で分ける (#301 の analyzerStatus と同じ考え方)。
4. **密度 gate は `verifySignedCheckpoints` から外す**。`signedCheckpoints.valid` は署名と連鎖の正しさだけを表す。密度不足は policy の違反として出す。cp が 0 件のときは今までどおり対象外 (`density: null`) とし、cp の存在を要求するのは `requireSignedCheckpoints` の役目にする。既存フラグの意味は厳しくしない (#296 のスコープ外)。
5. 既定のポリシーは空 (permissive)。フラグ無しの結論は今までと同じで、不足は今までどおり warning で出す。
6. **Web (verify) はポリシーを適用しない**。Web は閲覧と回収の場で、受理の判定は CLI と採点基盤が持つ。Web は cp の有無・最終署名・未署名の末尾の件数 (#295 の Anchoring カード) を表示する。その値は CLI の violations の元と同じ shared の結果から来る。この一致はパリティテストが固定する。
7. **time-box (releaseTime / deadline) と LMS の受領時刻はポリシーに入れない** (ADR-0013 の advisory のまま)。

## Consequences

### Positive
- 採点者は「署名 cp 必須」「最終署名必須」を CLI のフラグで指定できる (`--require-signed-checkpoints` / `--require-final-anchor`)。
- 結果を読む側は `integrityValid` を見れば改ざんかどうかを、`policy.violations` の code を見れば足りない証拠の種類を、それぞれ文言の解析なしに分けられる。
- 三層保証 (ADR-0020) の時刻アンカー層は、採点者のフラグに左右されなくなる。以前は密度 gate を立てると `signedCheckpoints.valid` が落ち、CLI と Web で時刻アンカーの表示が食い違った。

### Negative / Trade-offs
- `--require-anchor-density` を付けて密度が不足している proof の CLI 表示が変わる。以前は `Anchoring: FAILED (density gate)` だった。今は `Anchoring: VERIFIED` + `! Anchoring is sparse` で、Acceptance policy 節に `anchor-density-sparse` が出る。exit 1 は変わらない。
- `verifySignedCheckpoints` の `requireAnchorDensity` オプションは無くなる。shared の外から直接呼んでいる箇所は無い (verify / verify-cli は `verifyProofFile` 経由)。
- `--require-final-anchor` は、署名 token を取り直せない現状 (#236(b)) では、長い課題セッションの正直な提出を不受理にしうる。README に、短時間の試験以外で常用しないよう書いた。

### Follow-ups / 残課題
- 名前付きプロファイル (Option C) は需要が示されたら足す。
- #236(b) (署名 token の再取得) が入ったら、README の `--require-final-anchor` の運用注意を見直す。

## References

- 実装: [`packages/shared/src/acceptancePolicy.ts`](../../packages/shared/src/acceptancePolicy.ts)、[`packages/shared/src/verification.ts`](../../packages/shared/src/verification.ts) `verifyProofFile`、[`packages/verify-cli/src/output.ts`](../../packages/verify-cli/src/output.ts) (Acceptance policy 節)
- テスト: [`packages/shared/src/__tests__/acceptancePolicy.test.ts`](../../packages/shared/src/__tests__/acceptancePolicy.test.ts)、[`packages/verify/src/services/__tests__/webCliParity.test.ts`](../../packages/verify/src/services/__tests__/webCliParity.test.ts)
- 関連 ADR: [ADR-0013](0013-exam-schedule-advisory-keep-manifest-format.md) / [ADR-0016](0016-anchoring-density-signal.md) / [ADR-0017](0017-server-anchored-chain-root.md) / [ADR-0020](0020-three-layer-assurance-vocabulary.md) / [ADR-0024](0024-data-minimization-tiers.md)
- 関連 issue: #295 (未署名の末尾)、#296、#300 (保全と受理の分離)、#236(b)
