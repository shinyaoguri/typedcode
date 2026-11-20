# packages/verify — 検証キューと信頼スコア

`state/VerificationQueue` (Worker の待ち行列・キャンセル・障害) と `TrustCalculator` (issue リストとタブ status の軸) を触るときに読む。[AGENTS.md](../AGENTS.md) から移した節。

## 検証キュー (`state/VerificationQueue`)

- Worker は 1 本で、1 件ずつ処理する。待ち行列は **proof のイベント数の少ない順** (同数は到着順。処理中の 1 件は動かさない)。重い proof の後ろで軽い proof の結果が待たされないため (#331)
- `cancel(id)`: 待ち行列から外すか、処理中なら Worker を terminate して作り直して次へ進め、`onCancelled` を呼ぶ (→ `VerificationController.handleCancelled` が `cancelled` を流す)。`remove(id)` は同じ外し方でコールバックを呼ばず、その id のモード・問題パッケージも消す (ファイルを消したとき。`TabController.forgetFile` が呼ぶので、ファイル単体の削除もフォルダごとの削除も通る)
- **パース済みの proof は完了 (result / error / cancel / remove) で手放す**。再検証 (`reverifyWithManifest(id, manifest, proofData)` / キャンセル後の `requeue(id, proofData)`) は**呼び出し側がタブの `proofData` を渡す** (キューに写しを残さない)。`requeue` はいまの既定モードで並べ直す (重い full を止め、fast に切り替えてから再検証する逃げ道)
- 作り直す前の Worker や、処理中でない id から遅れて届いたメッセージは捨てる。`state/__tests__/VerificationQueue.test.ts` が Worker のモックで固定する
- **Worker 自体の障害 (`onerror`・`new Worker` の失敗) では、その個体を terminate して捨てる** (読み込みに失敗した Worker は後続の要求にも応答しない)。処理中の項目を 1 度だけエラーにし、次の項目は新しい Worker で処理する。応答 (result / error) を返せないままの障害が `MAX_CONSECUTIVE_WORKER_FAILURES` 回続いたら、処理中と待ち行列の項目をすべてエラーで終える (#700)。proof 単位の `error` メッセージは Worker の障害ではないので、同じ Worker のまま次へ進む

## 信頼スコア (`TrustCalculator`)

`TrustCalculator.calculate` は加減点スコアではなく **issue リスト** を組み立て、`determineLevel` で `failed`(error あり) / `partial`(warning あり) / `verified`(issue なし) に落とす。issue を上げる要素:

- **error**: metadata 不正、ハッシュチェーン不正、スクショ改竄、**提出物の不整合 (同梱ソースが `proof.content` と不一致・対応が曖昧。`source` component。#293)**、署名 cp が anchored だが invalid、**セッション開始トークンと署名 cp の sessionId 不一致 (spec §6.3。整合性ではなく `anchoring` 層に上げる)**、**token はあるが検証できない (`rootAnchorFailure`、#329。未登録 keyId / 署名不正 / 端末束縛の不一致。`anchoring` 層に上げ、そのときは root 未アンカーの warning を重ねない。文言は `trust.issueSessionTokenUntrusted.*` で、未登録 keyId のときだけ keyId と「registry が古い可能性」を出す)**、exam 束縛失敗 (package 提供時)
- **warning**: 未アンカー (署名 cp なし)、post-hoc 一括署名疑い、**アンカー密度が疎 (ADR-0016, `signedCheckpointDensity.sparse`)**、**root 未サーバアンカー (ADR-0017, `!rootAnchored` かつ非 exam)**、非ピュアタイピング (ペースト/バルク挿入)、**同梱ソースの欠落 (`source` component)**、`screenShareOptOut`、exam だが問題パッケージ未読込、スクショ欠損

`VerificationController.handleComplete` のタブ status 判定と **同じ軸** を見るので、両者を揃えて変更すること (タブが緑なのに信頼バッジが警告、のような不整合を避ける)。status の error 側は `proofVerification.isOverallValid` (= verify-cli の `valid` と同じ合成: shared の `verifyProofFile` × exam 束縛 × スクショ改竄) 一本に寄せてあるので、error 条件を増やすときは CLI 側も同時に見ること。`component` を増やしたら `ResultPanel.getComponentLabel` にラベルも追加する。#146 で handleComplete にスクショ改竄 (error)・スクショ欠損・`screenShareOptOut` (warning) を合流済み。attestation の署名は検証しないので status 軸にも信頼バッジにも入れない (#340)。

chain issue の `message` は常に翻訳済み文言 (`trust.issueChainInvalid`)。worker の英文 (`verificationResult.message`) は信頼バッジの issue には出さず、技術的な詳細は chain カード (`chainErrorDetails`) に出す (#281)。

スクショの per-image 判定 (ハッシュ突合 + チェーン裏付け) の実体は **shared の `checkScreenshotImage`** (#147)。verify 側で再実装しない — verify-cli と結論が食い違うため。
