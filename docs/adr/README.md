# Architecture Decision Records (ADR)

このディレクトリは、本プロジェクトで下された設計判断とその根拠を **append-only** で蓄積する場所です。コードは「どうなっているか」を語りますが、ADR は「**なぜそうなっているか**」を語ります。

## なぜ ADR を書くか

- AI エージェントが過去の議論をやり直さなくて済む (settled な判断を context として与えられる)
- 半年後の自分 / 新しい貢献者が経緯を辿れる
- 「コードを読めば分かる "What"」ではなく「コードを読んでも分からない "Why"」を記録する

## 何を書くべきか

- **新規追加で書く**: 複数の選択肢があり、片方を選んだ重要な判断 (アルゴリズム選択、互換性方針、フォーマット決定、責務分担)
- **書かなくてよい**: 自明なリファクタ、命名変更、軽微なバグ修正
- **判断基準**: 「6 ヶ月後にこの判断を覆そうとした人が、当時の議論を見ずに同じ結論に達するか?」が NO なら ADR にする

## 書き方

1. [`template.md`](template.md) をコピーして `NNNN-kebab-case-title.md` で保存
2. NNNN は連番 (4 桁 zero-padded)。既存最大 + 1
3. 1 ADR = 1 判断。複数の判断を 1 ファイルにまとめない
4. **コードと同じ PR で commit**。ADR と実装がアトミックに進む

## 改廃

- ADR は **append-only**。既存 ADR を編集しない (誤字脱字を除く)
- 判断を覆すときは **新しい ADR を追加し、旧 ADR の Status を `Superseded by ADR-NNNN` にする**
- 「やめた」場合は `Status: Deprecated` で残す

## 既存 ADR

| # | Status | Title |
|---|---|---|
| [0001](0001-hybrid-checkpoint-trigger.md) | Accepted | チェックポイントトリガをハイブリッド (events OR elapsed time) にする |
| [0002](0002-signed-checkpoints-with-ecdsa-p256.md) | Accepted | 署名済みチェックポイントは ECDSA-P256 + append-only 鍵レジストリ |
| [0003](0003-idempotent-signing-retry.md) | Accepted | 署名 API は内容ベースの冪等性で再送を吸収する |
| [0004](0004-verifier-checkpoint-stance.md) | Accepted | 検証側は未署名 cp の sampling を成功条件にしない |
| [0005](0005-input-type-policy.md) | Accepted | 許可/禁止 InputType の方針 |
| [0006](0006-exam-mode-sealed-problem-binding.md) | Accepted | 試験モードは封印問題パッケージで proof を試験にバインドする |
| [0007](0007-maximal-signal-capture.md) | Accepted | 記録/試験モードで捕捉する生信号を最大化し確定する |
| [0008](0008-exam-fullscreen-request-not-enforce.md) | Accepted | 試験モードはフルスクリーンを要求するが強制せず状態を記録する |
| [0009](0009-pluggable-analysis-layer.md) | Accepted | 改ざん検証と直交する pluggable な分析層フレームワークを定義する |
| [0010](0010-exam-session-model.md) | Accepted (sticky 部分は ADR-0011 で置換) | 試験モードのセッション構造 (1問1タブ・固定・リロード復帰可能) |
| [0011](0011-course-modes-and-path-routing.md) | Accepted | 授業・課題・試験を1ドメインのパスで分岐し能力プリセットでモデル化する |
| [0012](0012-sealed-starter-template-in-exam-payload.md) | Accepted | 封印問題の平文を構造化し N問バンドル＋問題ごとのスターターコードを同梱する |
| [0013](0013-exam-schedule-advisory-keep-manifest-format.md) | Accepted | 試験スケジュールを advisory とし manifest フォーマットは据え置く |
| [0014](0014-class-mode-unsealed-problem-distribution.md) | Accepted | 授業モードは平文 `.tcclass` で問題を配布し受動 fullscreen を記録する (tier ①) |
| [0015](0015-root-landing-and-casual-friction-reduction.md) | Accepted | ルート `/` をモード選択ランディングにし、通常モードの起動摩擦を下げる |
| [0016](0016-anchoring-density-signal.md) | Accepted | 署名 cp の「アンカー密度」をシグナル化し任意で gate する (末尾 1 点アンカー検出) |
| [0017](0017-server-anchored-chain-root.md) | Accepted | セッション開始 ECDSA トークンで casual/class の root をサーバアンカーする (format 1.2.0) |
| [0018](0018-istrusted-capture.md) | Accepted | 合成打鍵を `isTrusted` で捕捉し advisory シグナル化する (keystroke data に hashed・加算的) |
| [0019](0019-editor-assist-declaration.md) | Accepted | エディタ支援機能 (補完等) の実効状態を `environmentProbe` に宣言として焼く (記録のみ・ポリシーは別 ADR) |
| [0020](0020-three-layer-assurance-vocabulary.md) | Accepted | 保証を三層語彙 (整合性 × 時刻アンカー × 著述性[advisory]) で実証拠から機械導出し表示する |
| [0021](0021-code-execution-result-capture.md) | Accepted | コード実行の結果 (成功/失敗/exit code) を start/result の 2 イベントで加算的に捕捉する |
| [0022](0022-pre-export-self-review.md) | Accepted | 提出前セルフレビュー: 自分の過程要約を確認し任意の振り返り `reflectionNote` をチェーンへ記録する (exam は off) |
| [0023](0023-analysis-platform-not-judge.md) | Accepted | 分析を判定器ではなく多様な分析手法の差込み基盤として位置づける (verify-cli `--analyzer` 外部分析器・既定は advisory 据え置き) |
| [0024](0024-data-minimization-tiers.md) | Accepted | 目的別データ最小化ティア: 整合性は全イベント (Tier F)・分析/共有は content-free 派生物 (Tier A/S)。proof は redact しない |
| [0025](0025-grader-cohort-baseline.md) | Accepted | 採点者向けコホート基準を content-free な分布として定義 (外れ値は triage であって違反ではない・norms は配らない) |
| [0026](0026-lightweight-git-flow-branching.md) | Superseded by 0028 | ブランチ運用を軽量 Git Flow にする (release/* を省き develop→main は merge commit・feature→develop は squash) |
| [0027](0027-checkpoint-sign-requires-session-token.md) | Accepted | /api/checkpoint/sign を sessionStartToken 前提にする (DO 化は据え置き・無認証リクエストに KV コストを払わない) |
| [0028](0028-tag-based-github-flow.md) | Accepted | ブランチ運用をタグ式 GitHub Flow にする (main 1 本 + v* タグで production リリース・0026 を supersede) |

## 参考

- [ADR の元になった Michael Nygard の記事](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
- [docs/system-spec.md](../system-spec.md) — コード挙動の仕様 (What)
- 各 `packages/*/CLAUDE.md` — サブシステムの責務と不変条件
