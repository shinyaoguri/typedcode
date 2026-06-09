# ADR-0012: 封印問題の平文を構造化し、N問バンドル＋問題ごとのスターターコードを同梱する

- **Status**: Accepted (実装済み・develop マージ済み)
- **Date**: 2026-06-08 (Accepted: 2026-06-09)
- **Deciders**: (PR 上の合意者 / レビュアー)
- **PR / Commit**: #89 (ADR) / #90 (Phase1+2a: shared codec + grader v2) / #91 (Phase2b: editor N タブ解錠) / #92 (Phase3: /author N問オーサリング)。追加で #95 にて editor クロム統一・Markdown プレビュー(受験表示と統一)・スターターコードの C 実行。すべて develop マージ済み。

## Context

TypedCode には独立した2機能があり、いまは**直交**している。

- **テンプレート機能**（`packages/editor/src/template/`）: `.yaml` を**ローカル取込**して `files[]{filename, language, content}` を**ファイルごとのタブ**に流し込む（content = スターターコード）。取込時に `templateInjectionEvent`（templateHash / contentHash）を proof チェーンに記録する。**配布の仕組みは無い**（URL も署名も無いローカルファイル取込のみ）。
- **問題配布（`.tcexam`、ADR-0006）**: 出題者が署名・封印した問題を T0（監督コード）で解錠して配る。だが**封印される平文は「1問の問題文（純テキスト）」だけ**で、解錠時に作るのは**空のタブ1つ**。問題文は ProblemPanel に表示するのみ。

実際の演習・試験では「関数シグネチャ・I/O 定型・`// TODO` だけ書いた骨組み」を配り、学生に**ゼロから書かせず穴埋めさせる**ことが多い。これは概念的に **スターターコード = 問題に同梱して配る雛形**であり、配布チャネルを持つ `.tcexam` に同梱できれば「テンプレートに配布手段」「問題にスターターコード」が同時に成立する。

加えて議論で**運用モデルが2点確定**した:

- **タブの単位 = 問題（1問1タブ厳守）**。1回の試験に独立した N 問があれば **N タブ**開く（ADR-0010 の「1問1タブ」を保ったまま N に増やす）。**1問が複数ファイル**になるケース（main.c + util.h …）は当面**非対応**（後回し）。
- **配布は1つの `.tcexam` に N 問をバンドル**する（解錠1回で全問展開。教員は1ファイル配布）。

制約:

- **問題本文もスターターコードも T0 まで秘匿**（先に漏れると問題が読める）。
- 既存の単一問題 `.tcexam`（平文 = 生 markdown）との**後方互換**を壊さない。
- **暗号コア（Argon2id KDF / AES-256-GCM / ECDSA-P256 署名 / `packageHash`）は無改変・再実装しない**。変えるのは「何を平文に詰めるか」と「束縛の意味論を1問→N問へ広げる」ところだけ。
- ADR-0006 の束縛: `packageHash = SHA-256(canonical core)`、`problemContentHash = SHA-256(平文)`、`root = SHA-256(fingerprintHash ‖ localNonce ‖ packageHash ‖ startToken)`。

## Considered Options

### スターターコードと N 問を**どこに置くか**

#### Option A: manifest の平文（cleartext）フィールドに置く
- Cons: **T0 前に漏れる**（封印破り）。canonical core に入れると署名意味論の再設計が要る。**却下**。

#### Option B: 封印される**平文ペイロードを構造化する**（★採用）
平文を「生 markdown 文字列」から、バージョン付き JSON の**試験バンドル**へ拡張する:
```jsonc
{ "schema": "tcexam-exam/1",
  "problems": [
    { "problemId": "p1", "statement": "# 問題1 …md…",
      "starter": { "filename": "p1.c", "language": "c", "content": "/* TODO */" } },
    { "problemId": "p2", "statement": "…", "starter": { "filename": "p2.c", "language": "c", "content": "" } }
  ] }
```
各 `problems[i]` が **1タブ**になる（problem = tab）。`starter` は任意（無ければ空タブ＝現状同等）。
- Pros: 問題文もスターターコードも**封印の内側**で T0 まで秘匿。**暗号コア無改変**で、`packageHash`（署名）が平文全体（=全 N 問）を覆う。テンプレート機能の「N 件 → N タブ生成 + 注入イベント記録」機構を**そのまま再利用**できる（"files→tabs" が "problems→tabs" になるだけ）。後方互換は schema 判別（非 JSON / schema 無し → 従来の単一 markdown 問題）。
- Cons: 平文符号化（encode/decode）と**正準化**を単一真実源として shared に置き、authoring/editor/grader で一致させ続ける必要がある。**束縛を1問→N問へ拡張**する設計が要る（下記）。

#### Option C: 問題ごとに別 `.tcexam`（N ファイル配布）
- Pros: 1パッケージ=1問=1タブで ADR-0006 を**完全無改変**。
- Cons: 教員が N ファイル配る。**「1ファイルにバンドル」の運用決定に反する**ため却下。

### N問の束縛をどう担保するか（Option B 採用前提のサブ判断）

バンドルでは1つの `packageHash`・1つの監督コードに全 N 問がぶら下がる。各タブ（問題 i）の proof を「この封印の・この問題 i」に束縛したい。

#### B-1: root は据え置き、問題の同定は `proof.exam` で行う
- `root_i = SHA-256(fp ‖ nonce_i ‖ packageHash ‖ token)`（**現行式のまま**。各タブの nonce が違うので root は一意、全タブが同一 packageHash+token に束縛）。
- 各タブの `proof.exam` に **その問題の `problemId` と per-problem `problemContentHash`**（= `SHA-256(canonical(problems[i]))`）を記録。grader は復号 → `problemId` で問題を引き当て → 内容ハッシュ一致を確認。
- Pros: **root 式・`EXAM_ROOT_BINDING` を変えない**（実装・リロード復帰が軽い）。
- Cons: 「タブ↔特定問題」の結びは proof.exam の自己申告＋grader 照合（暗号的な genesis 束縛は bundle 単位）。

#### B-2: root に per-problem ハッシュを焼く（★推奨）
- `root_i = SHA-256(fp ‖ nonce_i ‖ packageHash ‖ token ‖ problemContentHash_i)`。
- Pros: 各タブの **genesis が「この封印の・この問題 i」に暗号的に束縛**され、問題ラベルの付け替えが root 不一致で露見する。バンドルのために format を上げるなら束縛も最初から airtight にできる。
- Cons: `computeExamChainRoot` 署名拡張＋`EXAM_ROOT_BINDING` のバージョン bump。単一問題 legacy 経路（problemContentHash を root に含めない v1）と分岐させる。

## Decision

**Option B を採用し、封印平文を試験バンドル `tcexam-exam/1`（`problems[]`、problem=tab）にする。** スターターコードと全 N 問は封印の内側に同梱され、`packageHash`（署名）が全体を覆う。**暗号コアは無改変**で、変更は (1) 平文 schema、(2) 束縛意味論の1問→N問拡張、(3) editor の N タブ生成（テンプレート機構の再利用）に限る。

束縛は **B-2（root に per-problem `problemContentHash_i` を焼く）を採る**（レビューで合意）。バンドルのために format を上げる以上、各タブの genesis を「この封印の・この問題」に airtight に束縛しておく。`EXAM_ROOT_BINDING` を `v2` へバージョン bump し、単一問題 legacy（v1 root = `fp ‖ nonce ‖ packageHash ‖ token`）と分岐する。v1 経路はバイト一致のまま据え置き、v2 のみ末尾に `problemContentHash_i` を連結する（固定長 hex なので境界は曖昧にならない）。

確定する設計点:

1. **平文符号化は shared の単一真実源**。`exam/` に `encodeExamBundle` / `decodeExamBundle`（untrusted JSON → 構造検証 or legacy fallback）と `computeProblemContentHash(problem)`（per-problem 正準ハッシュ）を置く。正準化（決定的 JSON シリアライズ・改行正規化）を定義し authoring/editor/grader で一致させる。
2. **problem = tab（1問1タブ厳守）**。各 `problems[i]` が1タブ。N 問 → N タブ。1問複数ファイルは非対応（schema に将来 `files[]` を足す余地は残すが今回は `starter` 単一ファイルのみ）。
3. **N タブ生成はテンプレート機構を再利用**。解錠後、`TemplateImporter` 相当のループで problems→tabs を **examContext 束縛つき**生成し、各タブに注入イベントを記録。`humanAttestation` は先頭タブで取り全タブ共有（現テンプレート実装と同じ）。
4. **束縛拡張**: 各タブの `proof.exam` に per-problem `problemId` / `problemContentHash_i`、root は B-2。grader（`verifyExamBinding`）は per-tab に「署名 → packageHash → root_i（per-problem 込み） → 復号 → problems[problemId] の内容ハッシュ一致」を検証。
5. **ProblemPanel は per-active-tab** 表示（アクティブな問題の `statement` を出す）。
6. **manifest**: `examId` は据え置き。バンドルである旨は平文 schema で表す（manifest 上の `problemId` はバンドル/試験ラベルとして残すか `*`）。format 識別が要るなら `formatVersion` を bump。
7. **後方互換**: 旧 `.tcexam`（単一 markdown・v1 root）は従来どおり1タブ解錠・表示。decode は schema/formatVersion で legacy 分岐。
8. **authoring（`/author`）**: N 問入力（各問: `problemId` + `statement` + 任意の `starter` ファイル）。既存 `.yaml` テンプレート取込→封印は将来導線。

## Consequences

### Positive
- 1試験 = 1署名付き `.tcexam` で **N 問＋各問スターターコードを秘匿配布**できる（教員は1ファイル配布、学生は解錠で N タブ）。
- スターターコードが署名・内容束縛の内側に入り、追加の暗号設計なしで守られる。
- テンプレート機能に**配布チャネル**が、問題に**スターターコード**が入り、タブ生成コードも再利用で重複減。
- **1問1タブの不変条件（ADR-0010）を保つ**。

### Negative / Trade-offs
- 平文 codec / 正準化 / per-problem ハッシュ / B-2 root が新たな**束縛契約**になり、ズレると解錠・検証が壊れる（`buildExamPackage` 同様の運用規律で守る）。
- `EXAM_ROOT_BINDING` と（必要なら）`formatVersion` の bump。legacy 経路の分岐保守。
- ADR-0010 のタブ生成・源流ロック・リロード復帰を **N タブへ一般化**（源流ロックは N タブ生成後に施錠）。
- `problemContentHash` がコード整形に敏感 → 正準化必須。

### Follow-ups / 残課題
- 実装フェーズ: (1) shared に bundle codec + per-problem ハッシュ + B-2 root + 後方互換 + テスト → (2) editor 解錠を `TemplateImporter` 再利用で N タブ exam 束縛（ProblemPanel per-tab・リロード復帰・源流ロック N タブ化） → (3) `/author` に N 問入力。
- 1問複数ファイル（軸: 1問 N ファイル）は別 ADR / 将来 schema 拡張（`problems[i].files[]`）。
- `.yaml` テンプレート ↔ bundle payload 相互変換。
- system-spec.md と shared/editor の CLAUDE.md に payload schema / 束縛式を明記。

## References

- 関連コード: [packages/shared/src/exam/examPackage.ts](../../packages/shared/src/exam/examPackage.ts)（`buildExamPackage` / `decryptExamPackage` / `computeProblemContentHash` / `computeExamChainRoot`）、[packages/shared/src/types/exam.ts](../../packages/shared/src/types/exam.ts)、[packages/shared/src/types/template.ts](../../packages/shared/src/types/template.ts)、[packages/editor/src/template/TemplateImporter.ts](../../packages/editor/src/template/TemplateImporter.ts)、[packages/editor/src/ui/components/ExamStartGate.ts](../../packages/editor/src/ui/components/ExamStartGate.ts)、[packages/editor/src/ui/components/ProblemPanel.ts](../../packages/editor/src/ui/components/ProblemPanel.ts)、[packages/editor/src/authoring/](../../packages/editor/src/authoring/)
- 関連 ADR: [ADR-0006](0006-exam-mode-sealed-problem-binding.md)（封印・束縛 — 本 ADR で1問→N問へ拡張）、[ADR-0010](0010-exam-session-model.md)（1問1タブ — N タブへ一般化）、[ADR-0011](0011-course-modes-and-path-routing.md)（モード体系）
- 関連 issue / PR: #80（出題者オーサリング）、#87 / #88（authoring seam / UI）
