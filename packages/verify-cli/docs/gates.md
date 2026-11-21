# packages/verify-cli — 試験の束縛・スクリーンショット・受理ポリシー

`--exam-package` / `--submitted-at`、スクリーンショットの検証、`--require-*` のフラグ (受理ポリシー) を触るときに読む。[AGENTS.md](../AGENTS.md) から移した節で、終了コードなどの不変条件は AGENTS.md にある。

## 試験モード (ADR-0006) の検証

- `--exam-package <file.tcexam>` (任意): 指定すると shared の `verifyExamBinding` で署名→packageHash→root→内容ハッシュ→識別子照合→time-box まで完全検証する。**未指定でも** `proof.exam` のある proof は root 束縛 (自己完結) を検証し「package 未提供」を明示する
- **識別子は束縛合格時のみ検証済み** (#273): `CLIExamResult` の `examId` / `problemId` / `variant` は、束縛が合格したときだけ shared の `verifiedIds` (署名済み manifest 側の値) になり `identifiersVerified: true`。package 未提供・束縛失敗では proof の自己申告値のままで `identifiersVerified: false`、`Exam:` 行に `(self-reported)` を付ける。**検証済みに見せない**ことが不変条件で、表示値は従来どおり `safe()` を通す
- `--submitted-at <ISO>` (任意): time-box の `withinWindow` 判定 (Moodle 提出時刻)。未指定なら window 表示のみ
- package 指定で束縛失敗は **exit 1**。exam 束縛のみ失敗時は出力ヘッダに束縛理由を出す (chain の成功メッセージを誤表示しない)
- **`--exam-package` を渡したら `exam` ブロックの無い proof も必ず束縛検証にかける** (#218)。呼び出し側で `proof.exam &&` を条件にすると、casual proof が何も検証されないまま exit 0 で通る (採点ゲートのサイレント無効化)。判定は shared の `verifyExamBinding` が fail-closed (`reason: 'Proof has no exam block'`) で持つので、CLI はそこへ**到達させる**だけ。ZIP では per-proof に失敗させる (不変条件 3 と同型)
- **束縛が「対象外の proof」で落ちても `integrity` は落とさない**: これはゲートの誤用であって改ざんではない (ADR-0020 の語彙)。`deriveAssurance` へ渡す `exam.present` を固定値 `true` にしないこと
- `--submitted-at` は time-box (advisory) 専用。`--exam-package` 無しでは効かないので warning を出す (exit code は変えない)
- ロジックは全て shared (`verifyExamBinding` / `parseExamPackageManifestResult`) に委譲。CLI は薄いラッパに留める。`.tcexam` の取込は理由つきの `parseExamPackageManifestResult` を使い、未知の `formatVersion` (新旧) と形式不正を出し分ける (null を返す旧 `parseExamPackageManifest` は使わない。#223)
- **proof の形式バージョン (#223)**: 判定 (`versionStatus`) は shared の `verifyProofFile` が持つ。CLI は `newer` を合否の直下の warning として出し (exit code には干渉しない)、`tooOld` / `malformed` は `errorMessage` を `Error:` に出す。**自己申告の `proof.version` は生で stdout に出さず**、`verify.ts` が `parseVersionStrict` で数字に正規化した `declaredVersion` だけを使う (shared AGENTS.md 不変条件 11)

## スクリーンショット検証 (#147)

- ZIP 入力のとき、`screenshots/manifest.json` の entry と画像バイト列を突合し、さらにチェーンの `screenshotCapture.imageHash` (改ざん不能な唯一の真正記録) との裏付けを検査する。判定は **shared の `summarizeScreenshotArtifacts` / `checkScreenshotImage`** (verify web と同一実装) — CLI 側で再実装しない
- **改ざん (tampered) は exit 1** (web の error 軸 / integrity failed と同じ結論)。欠損・chainOnly (チェーンに記録があるのに manifest に無い = 剥ぎ取り疑い) は warning のみで exit 非干渉
- チェーンが健全でスクショだけ改ざんのときは、出力ヘッダに改ざん枚数を出す (#217)。exam 束縛のみ失敗と同型で、chain の成功メッセージを `Error:` として誤表示しない (両方落ちたときは両方出す)
- JSON 単体入力は画像が無いので未検査 — 出力に `Screenshots: not checked` を明示する (overclaim 防止)
- サマリは ZIP 単位で一度だけ計算し全 proof に共有する (スクショはセッション単位で proof 横断)。`deriveAssurance` へは `screenshotsTampered` として渡る

## 受理ポリシー (ADR-0043)

- 4 つの opt-in 要件を受理ポリシーとして評価する: `--require-root-anchor` (`root-anchor-missing`) / `--require-anchor-density` (`anchor-density-sparse`) / `--require-signed-checkpoints` (`signed-checkpoints-missing`) / `--require-final-anchor` (`terminal-anchor-missing`。未署名の末尾の件数つき)。判定は shared の `evaluateAcceptancePolicy` (`verifyProofFile` が呼ぶ) に委譲し、CLI はフラグを通すだけ。**CLI に判定式を書かない**
- 結果は整合性 (`integrityValid`) と違反 (`policy.violations`) に分かれて返る。総合 `valid` (= exit code) は `integrityValid && violations が空`。整合性が落ちた proof ではポリシーを評価しない (`policy.evaluated: false`)
- 出力は、フラグを 1 つでも立てたときだけ `--- Acceptance policy ---` 節を出す。**フラグ無しの出力は変えない** (既定のポリシーは空 = 従来どおりの結論。不足は warning のまま)。`--analysis-json` の各要素にも `policy` を載せる。`--analysis-bundle` (Tier A) には載せない (content-free な派生物で、ポリシーは採点側の設定)
- 違反した proof も、他の入力の検証と `--analysis-*` / `--extract-sources` を止めない (不変条件 6 の経路)
- time-box (`--submitted-at`) と LMS の受領時刻はポリシーに入れない (ADR-0013 の advisory のまま)
- `--require-final-anchor` は #236(b) (署名 token の再取得) の着地前は、短時間の試験以外で常用しない (README に明記)

## アンカー密度 gate (ADR-0016)

- `--require-anchor-density` (任意・boolean): 署名 cp が「主張したイベント数 / 経過時間」に対して**疎**な proof を **exit 1** にする (採点向け opt-in)。既定は warning のみで `Anchoring` 行の下に `! Anchoring is sparse …` を出す
- 判定は shared の受理ポリシー (ADR-0043、`anchor-density-sparse`) に委譲。CLI は `verifyProofFile` にフラグを通すだけ。閾値 (cadence×5) は shared の `computeDensity` が単一ソース。密度不足は `signedCheckpoints.valid` を落とさない (Anchoring 行は `VERIFIED` + `! Anchoring is sparse`、Acceptance policy 節に違反)。cp が 0 件の proof は対象外 (`density: null`)。cp の存在を求めるのは `--require-signed-checkpoints`
- 末尾 1 個の署名 cp で長いチェーンをアンカーする手口を捕捉する (`coverageRatio` は 1.0 でも疎)。**非破壊** (proof フォーマット不変)

## root アンカー gate (ADR-0017)

- `--require-root-anchor` (任意・boolean): root がサーバアンカーされていない (`sessionStartToken` 無し = オフライン劣化 / 旧 proof) proof を **exit 1** にする (採点向け opt-in)。既定は warning のみで `Root anchor: unanchored` を出す。token はあるが検証できない proof (`rootAnchorFailure`、#329) は既定で exit 1 (整合性は落とさない) で、`Root anchor: UNTRUSTED (<理由>)` を出す (`no session start token` と出さない。keyId は `safe()` を通す)。gate を立てていても Error 行は token の失敗理由を優先する。**exam proof の免除は束縛が検証済み (`--exam-package` で `verifyExamBinding` 合格) のときのみ** (#131) — 自己申告の exam ブロックだけでは gate を回避できない
- 判定は shared の `verifyProofFile` (`requireRootAnchor` + `examBindingVerified`) に委譲 (受理ポリシーの `root-anchor-missing`。ADR-0043)。CLI は `verifyExamBinding` を先に実行して結果フラグを通すだけ。proof は `PROOF_FORMAT_VERSION` 1.2.0 (`MIN_SUPPORTED` 1.0.0 据置) なので **旧 proof もそのまま検証**でき、`rootAnchored:false` で受理 (後方互換)
