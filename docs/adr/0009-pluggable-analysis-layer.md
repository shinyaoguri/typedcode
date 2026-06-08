# ADR-0009: 改ざん検証と直交する pluggable な分析層フレームワークを定義する

- **Status**: Accepted (実装済み・develop マージ済み)
- **Date**: 2026-06-06 (Accepted: 2026-06-08)
- **Deciders**: (PR 上の合意者 / レビュアー)
- **PR / Commit**: develop マージ済み

> ADR-0007 が「**分析ロジックは別 ADR・後段で pluggable**」と明記した、その別 ADR。捕捉済み信号を消費して**生成 AI 利用を間接判定する分析層**の枠組みを確定する。本 ADR は **framework（差し込み口・出力モデル・実行場所・配置/開示・evasion 方針）を確定**し、**4 分析器それぞれのアルゴリズムは後続 spec/ADR に委ねる**（進化＆evasion 感度が高いため）。

## Context

ADR-0006（封印問題束縛）・ADR-0007（生信号の最大捕捉）・ADR-0008（フルスクリーン記録）で「**束縛**」と「**捕捉**」を確定した。残るのが捕捉信号を消費する「**分析**」=「これは人間が打ったものか / 生成 AI の出力を転写したものか」を間接判定する層。前提:

- **検証と分析は別物 (直交)**:
  - **検証** = `verifyProofFile() → FullVerificationResult` ([packages/shared/src/verification.ts](../../packages/shared/src/verification.ts))。chain / PoSW / 署名 cp の**暗号的整合性**。決定論的で settled。**触らない**。
  - **分析** = 人間らしさ / 異常度。**確率的・ヒューリスティック・反証可能で差し替え前提**。
  - 暗号的に VALID な proof でも分析は「要確認」になり得るし、その逆もある。**混ぜてはならない**。
- **クライアントは半信頼/敵対的**: コードは公開なので**捕捉ロジックは隠せない** (クライアント JS)。一方**分析ロジックは隠せる/進化させられる**。ここに非対称性がある。
- **ブラウザの限界 (ADR-0007 と同じ)**: 他アプリを見られない → AI 直接検出は不可能。分析は常に間接 (入力の出自・liveness・ギャップ)。判定の本丸は**監督 (air gap) ＋証拠**。
- **試験倫理**: 誤検知は致命的。誤った告発はデュープロセス上も許されない。→ 出力は**人間のレビューを補助する advisory** でなければならない。
- **既に散在する advisory の芽**: コードには既に `isPureTyping` (paste/drop 検出)、`suspiciousBulkInsertEventIndexes`、署名 cp の `postHocSuspected`、verify の**空の `typingPatternAnalysis` / TypingPatternCard** がある。本 ADR はこれらの**散在 advisory を統合する受け皿**でもある (ゼロからの新設ではない)。

## Considered Options

### Option A: 検証に統合する (analyzer を `verifyProofFile` に組み込み `valid` に反映)
- Pros: 単純、1 か所。
- Cons: **暗号的整合性と確率的判定を混ぜる**＝致命的。人間らしさが `VALID/INVALID` に混入し、誤検知が「検証失敗」に化ける。差し替え不能。デュープロセスにも反する。→ **却下**。

### Option B: verify / verify-cli に直書きする (分析を web/CLI それぞれにハードコード)
- Pros: すぐ書ける。
- Cons: ロジック重複、pluggable でない、進化のたび両方改修。ADR-0007 の「差し替え前提」に反する。→ **却下**。

### Option C: 検証と直交する pluggable framework として分離定義する
- 契約 `Analyzer.analyze((proof, verification)) → AnalysisSignal[]`、orchestrator が N 個を合成して `AnalysisReport` を生成。
- 出力は **advisory signal ＋証拠 ＋要確認優先度のみ**、**判定 (pass/fail) はしない**。
- 契約/型/orchestrator は shared、開示可の分析器は verify＋CLI、感度高は採点者側 private。**proof には焼かない** (後付け・再実行可能)。
- 4 次元は**初期分析器セット**だが各アルゴは別 spec/ADR。
- Pros: 直交性保持・差し替え可・再実行可・evasion 耐性 (感度高ロジック非配布)・既存 advisory の統合先。
- Cons: 抽象 (contract/orchestrator/registry) の導入コスト、感度高分析器の配布管理。→ **採用**。

## Decision

Option C を採用。中心判断 = **分析層は暗号検証と直交する pluggable framework**。確定事項:

1. **直交**: `verifyProofFile` / `FullVerificationResult` は**不変**。分析は `(ExportedProof, FullVerificationResult)` を消費する**新規 consumer**。暗号 VALID と分析スコアは独立軸として併記する (一方が他方を上書きしない)。
2. **post-hoc / オフライン / クリティカルパス外**: 採点時に export 済み proof に対して走る。**エディタ内でライブには走らせない** (ADR-0008「止めない」原則・サーバ best-effort と整合)。
3. **契約 (framework の核)** — 具体型は実装 PR で確定するが、形は以下:
   ```typescript
   type AnalysisDimension =
     | 'automation'                    // 合成入力検出
     | 'keystroke-content-consistency' // 打鍵動態 ↔ 内容の整合
     | 'transcription-topology'        // 構築の形 (線形転写 vs 著述)
     | 'focus-burst-correlation';      // 離脱 ↔ バーストの相関

   interface AnalysisInput { proof: ExportedProof; verification: FullVerificationResult; }

   interface EvidenceRef { fromEventIndex: number; toEventIndex?: number; note?: string; }

   interface AnalysisSignal {
     analyzerId: string;
     dimension: AnalysisDimension;
     score: number;        // 0..1 異常度
     confidence: number;   // 0..1 確信度
     severity: 'info' | 'notice' | 'review';
     evidence: EvidenceRef[];   // 必須: event index / 時間範囲への参照
     summary: string;
   }

   interface Analyzer { id: string; version: string; analyze(input: AnalysisInput): AnalysisSignal[] | Promise<AnalysisSignal[]>; }

   interface AnalysisReport {
     analyzerVersions: Record<string, string>;
     signals: AnalysisSignal[];
     reviewPriority: number;   // 集約された「要確認」度 — 判定ではない
   }
   ```
   - **判定しない**: 自動 pass/fail を出さない。`reviewPriority` は**人間レビューの優先度**のみ。最終判断は監督/採点者。
   - **証拠リンク必須**: 各 signal は event index / 時間範囲を指し、人間が当該箇所を検分できる。
4. **配置 / 開示**: 契約・型・orchestrator・出力モデルは **shared (の非 crypto モジュール)**。開示してよい分析器 (自動化判定など) は **verify＋CLI に同梱**。閾値/重みが感度高いものは**採点者側 private** (verify-cli のビルドに注入、web verify には配布しない)。**proof に分析結果を焼き込まない** (後付け・再実行可能成果物、`analyzerVersion` で出自記録)。
5. **初期分析器セット = 4 次元** (自動化判定 / keystroke↔content 整合 / 転写トポロジー / focus↔バースト相関)。各アルゴリズムは**別 spec/ADR** で確定する (進化＆evasion 感度のため本 ADR では決めない)。
6. **既存 advisory の収容**: `isPureTyping` / bulk-insert 疑い / 署名 cp `postHocSuspected` 等の散在信号は、将来この framework の signal として**段階的に再表現**できる (後方互換、急がない)。

## Consequences

### Positive

- 暗号検証の純度を保ったまま、人間らしさ分析を**任意に差し替え/追加**できる。
- ADR-0007 の全捕捉が活き、**古い proof も将来の改良分析器 (ML 含む) で再評価可能**。
- 感度高ロジックを非配布にでき、**evasion 耐性**を確保 (公開クライアントの非対称性を利用)。
- 出力が advisory ＋証拠 ＋優先度のみ ＝ **誤検知の致命性を回避**し、監督/採点者の判断を補助する。
- verify の空 `TypingPatternCard` 等、既存の半端な分析 UI に**正式な受け皿**を与える。

### Negative / Trade-offs

- 抽象 (contract / orchestrator / registry) の導入コスト。
- 感度高分析器の**配布管理** (採点者側ビルドに private 注入する運用フローが要る)。
- **evasion との軍拡**: 分析を公開する分だけ回避されやすい → 感度高は非公開＋進化前提で緩和。
- 分析の有効性そのものは**未実証** (4 次元の精度・誤検知率は実データ評価が必要) → advisory 立て付けで被害を限定。

### Follow-ups / 残課題

- **4 分析器それぞれのアルゴリズム spec/ADR** (推奨順: 自動化判定 → keystroke↔content → 転写トポロジー → focus↔バースト)。各々に評価 (誤検知率・回避耐性)。
- `AnalysisReport` / `AnalysisSignal` の**具体型を shared / system-spec.md に定義** (最初の分析器実装 PR と同時)。
- **orchestrator / registry** の実装 (`checkpointKeys` registry が参考)。
- verify の **`TypingPatternCard` を `AnalysisReport` 駆動に再配線**、verify-cli に `--- Analysis ---` セクション追加。
- 感度高分析器の **private 配布フロー** (採点者側ビルドへの注入手順) の設計。
- 既存散在 advisory (`isPureTyping` 等) の **signal への段階移行**方針。

## References

- [ADR-0007](0007-maximal-signal-capture.md) — 生信号の最大捕捉 (本 ADR はその**消費側**)
- [ADR-0006](0006-exam-mode-sealed-problem-binding.md) — 試験モードの封印問題束縛
- [ADR-0005](0005-input-type-policy.md) — paste/import の構造的禁止 (入力出自の既存方針)
- [ADR-0004](0004-verifier-checkpoint-stance.md) — 未署名 cp を成功条件にしない (**advisory を成功条件にしない**既存前例)
- [packages/shared/src/verification.ts](../../packages/shared/src/verification.ts) — `verifyProofFile` / `FullVerificationResult` (直交する暗号検証)
- [packages/shared/src/types/proof.ts](../../packages/shared/src/types/proof.ts) — `ExportedProof` / `StoredEvent` (分析の入力)
- `packages/verify/src/ui/ResultPanel.ts` — `TypingPatternCard` (分析 UI の受け皿)
- `packages/verify-cli/src/output.ts` — CLI 出力 (`Analysis` セクション追加先)
- [docs/system-spec.md](../system-spec.md) — 型定義の定義先
