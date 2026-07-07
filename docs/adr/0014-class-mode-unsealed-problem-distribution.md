# ADR-0014: 授業モードは平文 `.tcclass` で問題を配布し、受動的に fullscreen を記録する (tier ①)

- **Status**: Accepted (実装済み・develop マージ済み)
- **Date**: 2026-06-09
- **Deciders**: (PR 上の合意者 / レビュアー)
- **PR / Commit**: PR #97 (feat/class-mode-capabilities)

## Context

ADR-0011 は演習授業の 4 モード (casual/class/assignment/exam) を path で分岐し、能力プリセットでモデル化した。そのうち **class (授業)** だけが「監督下だが**封印しない**(問題は公開)」という設計意図を持ちながら、実装は `class: CASUAL` で casual と同一能力のまま放置されていた (ADR-0011 §3/§4 の繰り越し)。

ADR-0011 §4 は問題配布の真正性を **3 段階**で定義した:

- **① 自己申告 (メタデータ)** — proof に `mode`/`problemId` を書くだけ。**課題/授業の既定**。
- **② 署名付き記述子** — per-student variant を採る段でのみ必要。当面実装しない。
- **③ 封印 (`.tcexam`)** — 試験のみ。

本 ADR は class の問題配布フォーマットと能力集合を **tier ① の具体形**として確定する。制約:

- **暗号コア (ADR-0006/0012) を再実装・改変しない**。class は封印しないので KDF/AES/署名を持たない。
- **proof フォーマットを破壊しない** (`PROOF_FORMAT_VERSION` 据え置き)。新イベント型/新 proof フィールドを足さない。
- 問題バンドルの codec (ADR-0012, `tcexam-exam/1`) を**平文のまま再利用**する。
- fullscreen は ADR-0011 の能力表で class は「**任意**」。exam の要求バナーとは区別する。

## Considered Options

### 配布フォーマット

#### Option A: exam の `.tcexam` を「監督コード任意」で流用 (封印したまま復号をスキップ)
- Pros: ExamStartGate を最大限再利用。
- Cons: 封印前提の UI (監督コード入力・署名検証・GCM 復号) と混ざりコンセプトが濁る。「公開問題」なのに封印の殻だけ残る。**却下**。

#### Option B: 平文 `.tcclass` (新フォーマット、暗号・署名なし) ★採用
- 構造: `{ schema: 'tcclass/1', classId, allowed:{languages}, bundle: ExamBundle }`。`bundle` は exam と**同一の `ExamBundle` (`tcexam-exam/1`)** を平文で内包し、`parseExamBundle` を共有。
- Pros: tier ① に忠実 (暗号なし・公開前提)。codec を再利用。受講者は監督コード不要で読み込める。/author が「封印する/しない」の 1 系統で配布物を出せる (ADR-0011 follow-up)。
- Cons: 真正性は自己申告のみ (= 設計通り。問題は公開、上方詐称は試験の暗号束縛が、取り違えは Moodle が拾う)。

#### Option C: 署名付き (tier ②) の非暗号記述子
- Pros: 出題者の真正性が付く。
- Cons: ADR-0011 が「per-student variant を採る段でのみ」と保留にした段階。class の既定 (tier ①) を越える over-engineering。**見送り**。

### fullscreen の振る舞い

#### Option D: exam と同じ要求バナー
- Cons: 授業中ワークに常時「フルスクリーンで受験」バナーは過剰。**却下**。

#### Option E: 受動記録のみ ★採用
- fullscreen 状態 (`fullscreenChange`) は記録するが、警告バナー/要求ボタンは出さない。ADR-0011 の「任意」に合致。

## Decision

**class は平文 `.tcclass` (Option B) で問題を配布し、受動的に fullscreen を記録する (Option E)。**

- **能力集合**: casual に対し `problemPanel`(問題表示) と `fullscreenTracking`(記録) を足し、新設の `fullscreenBanner` を false にする (受動)。`tabLock` は緩 (false)、汎用 DL も残す (`unifyDownloadToProblemPanel: false`)。教室・多人数・不安定網ゆえ `preExportBestEffort: true` (export を Turnstile でブロックしない)。
- **タブ展開**: class タブは **casual タブ** (`examContext` なし → 通常の genesis、**root 束縛なし**)。バンドル各問を 1 タブで開き (ADR-0010/0012 の 1問1タブを踏襲)、スターターコードは既存の `templateInjectionEvent` で「与えられた雛形」として注入する。`templateName='tcclass/${classId}/${problemId}'` が **self-asserted problemId を proof に残す** (tier ①「proof に problemId を書く」を新フィールドなしで達成)。
- **モードラベル**: `mode:'class'` は既存の `ProofExporter.setMode` が自己申告で記録する。
- **真正性**: 署名検証はしない。`parseClassPackage` は構造検証のみ。

決め手: tier ① は「上に偽れない (試験の保証は暗号束縛由来)・下に偽る動機がない・取り違えは Moodle が拾う」ので、class に署名/封印は不要。codec 再利用で実装も最小、proof 互換も保てる。

## Consequences

### Positive
- class が「問題配布 → 表示 → N タブ展開 → 受動 fullscreen 記録」まで成立。授業中ワークに使える。
- **proof 完全後方互換** (新イベント型/フィールドなし、`PROOF_FORMAT_VERSION` 据え置き)。
- /author が封印 (`.tcexam`) と未封印 (`.tcclass`) の両方を 1 ツールで出せる。
- 暗号コアに一切触れないので exam の安全性に影響しない。

### Negative / Trade-offs
- class proof の保証は**低い** (formative)。AI 写経は防げない (ADR-0011 の割り切り通り)。
- panel-follows-tab は **filename 照合** (class タブは `examContext` を持たず problemId を proof から引けないため)。filename はセッション/リロードで安定なので堅牢だが、exam の problemId 照合とは経路が異なる。

### Follow-ups / 残課題
- assignment 固有の問題配布 UX (現状 assignment は問題表示を持たない)。
- per-student variant の tier ② 署名記述子 (別 ADR)。
- 1問複数ファイル (ADR-0012 と同じく当面非対応)。

## References

- `packages/shared/src/exam/classPackage.ts` — `.tcclass` codec (parse/encode、暗号なし)
- `packages/shared/src/types/exam.ts` — `ClassPackage` 型
- `packages/editor/src/core/mode.ts` — `CLASS` 能力プリセット + `fullscreenBanner`
- `packages/editor/src/ui/components/ClassProblemLoader.ts` — 非ブロッキング問題ローダ
- `packages/editor/src/authoring/classPackageAuthoring.ts` — /author の `.tcclass` 生成
- [ADR-0011](0011-course-modes-and-path-routing.md) — モード体系・3段階真正性 (本 ADR は §4① を具体化)
- [ADR-0012](0012-sealed-starter-template-in-exam-payload.md) — N問バンドル codec (`tcexam-exam/1`、class が平文で再利用)
- [ADR-0006](0006-exam-mode-sealed-problem-binding.md) — 封印 (③、class は持たない)
- Issue [#80](https://github.com/shinyaoguri/typedcode/issues/80) — 教員向け問題/課題作成ツール
