# ADR-0023: 分析を「判定器」ではなく多様な分析手法の差込み基盤として位置づける

- **Status**: Accepted
- **Date**: 2026-06-12
- **Deciders**: (PR 上の合意者 / レビュアー)
- **PR / Commit**: develop へ stacked-PR

> ADR-0009 が分析層を「検証と直交する pluggable な advisory framework」と定めた。本 ADR はその**プロダクト方針**を一段明文化する: **TypedCode 自身は AI 利用を判定しない**。我々は採点者・研究者が**自分のデータと自分の分析器**で判断できる**基盤**を提供する。W5 (ADR-0009 系列の実証評価) の枠組みもこの方針で再定義する。

## Context

W5 で「分析器を `severity: 'review'` に昇格してよいか実測で判断する評価ハーネス」(`evaluateAnalysis`) を入れた (PR #107)。当初はこれを「**我々が**4条件×IME でコーパスを収集し、閾値を決め、既定分析器を強化する」前提で設計していた。

しかしプロダクトの意図はそこではない:

- **TypedCode は判定器ではない**。整合性・時刻アンカーは暗号で決定的に言えるが、「AI で作ったか」は**ブラウザ内では原理的に間接判定**しかできず (ADR-0007/0009)、誤検知はデュープロセス上許されない。最終判断は常に**監督者・採点者**にある (ADR-0020 三層保証で著述性は常に advisory)。
- **我々はデータを収集しない**。打鍵分布・IME 挙動・転写癖は文脈依存で、評価コーパスは**採点者/研究者が自分の現場で持つ**べきもの。我々が代表性のないコーパスで「正解の閾値」を焼き込むと、むしろ誤った権威づけになる。
- **価値は手法の多様性そのもの**にある。ADR-0009 は既に「感度の高い本物の分析器は採点者側に private で足す」と書いた。この差込み口を**第一級のプロダクト機能**に格上げし、研究者が手法を載せ替え・比較できる基盤にしたい。

つまり「アナライザを我々が育てて昇格させる」のではなく、「**アナライザを載せ替えられる土台**と、**各自が自分のデータで検証する道具**を提供する」へ重心を移す。

## Considered Options

### Option A: TypedCode が既定分析器を実測で強化し、`review` 判定まで踏み込む
- Pros: 利用者は何もしなくても「強い」判定が得られる。
- Cons: 代表性のないコーパスで閾値を焼くと誤った権威づけ。誤検知の責任を我々が負う構造。ブラウザ内間接判定の限界 (ADR-0007) を「判定」と見せてしまう。ADR-0009/0020 の advisory 原則・デュープロセスに反する。→ **却下**。

### Option B: 分析機能を持たない (検証だけ提供)
- Pros: 最小・誤用なし。
- Cons: 「過程を採点・教育に活かす」というプロダクトの第二の意図 (process-first) を捨てる。既に配線済みの advisory framework (ADR-0009) を死蔵。→ **却下**。

### Option C: 判定はせず、多様な分析手法の**差込み基盤**として提供する (本 ADR)
- 既定分析器は**方向性を示す advisory プレースホルダのまま** (`notice` 止まり)。我々は閾値を焼かない。
- `Analyzer` 契約 (ADR-0009) を**安定 public API** として明文化し、採点者/研究者が自前の分析器を**フォークせず**差し込める口を CLI に持たせる (`--analyzer <module>`)。
- `evaluateAnalysis` (W5) は「**我々が**昇格判断する道具」ではなく「**各自が自分のデータと分析器を検証する**道具」として位置づけ直す。プロトコル文書も参照手順に再フレーム。
- 感度の高い本物の分析器は引き続き**採点者側 private** (配布しない = evasion 耐性、ADR-0009)。
- Pros: 判定の権威を持たない (誤検知責任を負わない)・手法の多様性と進化を促す・既存 framework を活かす・ADR-0009/0020 と整合。
- Cons: 「箱から出してすぐ強い判定」は得られない (基盤であって完成品ではない)。差込み口の契約安定性を維持する責務が生じる。→ **採用**。

## Decision

**Option C** を採る。TypedCode は AI 利用を判定しない。整合性・時刻アンカーは決定的に保証し、**著述性 (人間が書いたか) は常に advisory**。分析は「検証と直交する、載せ替え可能な手掛かり生成」であり、最終判断は採点者・研究者にある。

具体化:

1. **既定分析器は advisory のまま据え置く** (`notice` 止まり)。我々が実測で閾値を焼いて `review` に昇格することはしない。`automation` の決定的 tell (`webdriver`/自動化グローバル/`isTrusted=false`) のみ既に `review` だが、これはヒューリスティックではなく環境の事実シグナル。
2. **`Analyzer` 契約を安定 public API として明文化する** (`AnalysisInput` が渡すもの = 検証済み proof の全イベント列・fingerprint・`FullVerificationResult`、返すもの = `AnalysisSignal[]`)。
3. **verify-cli に `--analyzer <module>` / `--no-default-analyzers`** を追加し、外部 ES モジュールの `Analyzer` を `runAnalysis` に差し込めるようにする (I/O は CLI、分析ロジックは外部モジュール)。
4. **`evaluateAnalysis` (W5) と収集プロトコルを「各自が自分のデータで検証する道具」に再フレーム** (docs/analysis-eval-protocol.md)。我々のデータ収集は前提にしない。

## Consequences

### Positive
- 判定の権威・誤検知責任を我々が負わない。ブラウザ内間接判定の限界を「判定」と偽らない (誠実)。
- 研究者・採点者が手法を載せ替え・比較できる (多様性と進化)。感度の高い分析器は private に保てる (evasion 耐性)。
- 既存の ADR-0009 framework / `evaluateAnalysis` / `--analysis-json` が一貫した「研究基盤」として結線される。

### Negative / Trade-offs
- 「すぐ使える強い判定」は提供しない (基盤であって完成品ではない)。利用者側に分析器の用意 or 既定 advisory の解釈を委ねる。
- `Analyzer` 契約 (`AnalysisInput`/`AnalysisSignal`) を**安定 API** として維持する責務。破壊的変更時は外部分析器が壊れるため慎重に。
- 外部モジュールを動的 import するため、CLI 利用者が**信頼できるモジュールだけ**を渡す前提 (任意コード実行)。help / docs に明記。

### Follow-ups / 残課題
- verify (web) でも外部分析器を差し込めるようにするか (ブラウザでの任意モジュール読込は要検討、当面 CLI のみ)。
- `Analyzer` 契約の semver 方針 (どこからが破壊的変更か) の明文化。
- ★5 grader ベースライン/コホート ADR、★7 データ最小化ティア ADR は本方針 (各自がデータを持つ) と地続きで設計する。

## References

- ADR-0009 (pluggable analysis layer / 直交性・advisory・private 分析器)
- ADR-0007 (最大信号捕捉とブラウザ内間接判定の限界)
- ADR-0020 (三層保証語彙: 著述性は常に advisory)
- `packages/shared/src/analysis/types.ts` (`Analyzer` / `AnalysisInput` / `AnalysisSignal` 契約)
- `packages/shared/src/analysis/eval.ts` (`evaluateAnalysis` — 各自がデータで検証する道具)
- `packages/verify-cli/src/analyzers.ts` (`--analyzer` 外部モジュール読込)
- `docs/analysis-eval-protocol.md` (参照プロトコル + ハーネス)
