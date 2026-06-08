# ADR-0012: 封印問題の平文を構造化し、スターターコード（テンプレート）を同梱する

- **Status**: Proposed
- **Date**: 2026-06-08
- **Deciders**: (PR 上の合意者 / レビュアー)
- **PR / Commit**: #NN (ADR) / 後続実装 PR

## Context

TypedCode には独立した2つの機能があり、いまは**直交**している。

- **テンプレート機能**（`packages/editor/src/template/`）: `.yaml` を**ローカル取込**して `files[]{filename, language, content}` を**ファイルごとのタブに流し込む**（content = スターターコード）。取込時に `templateInjectionEvent`（templateHash / contentHash）を proof チェーンに記録する。**配布の仕組みは無い**（URL も署名も無いローカルファイル取込のみ）。`metadata.description` は確認モーダルに出るだけで永続表示しない。
- **問題配布（`.tcexam`、ADR-0006）**: 出題者が署名・封印した問題を T0（監督コード）で解錠して配布する。だが**封印される平文は「問題文（純テキスト）」だけ**で、解錠時に作るのは**空のタブ1つ**（[main.ts](../../packages/editor/src/main.ts) の exam 解錠分岐は content=`''`）。問題文は ProblemPanel に表示するのみ。

実際の演習・試験では「関数シグネチャ・I/O 定型・`// TODO` だけ書いた骨組み」を配り、学生に**ゼロから書かせず穴埋めさせる**ことが多い。これは概念的に **テンプレート = 問題のスターターコード**であり、配布チャネルを持つ `.tcexam` に同梱できれば「テンプレートに配布手段」「問題にスターターコード」が同時に成立する。

制約:

- **スターターコードは問題の一部であり T0 まで秘匿すべき**。先に漏れると問題構造が読めてしまう（air-gap 前提の意味が薄れる）。
- 既存の `.tcexam`（平文 = 生 markdown）との**後方互換**を壊さない。
- 暗号束縛（ADR-0006）の不変条件—`packageHash`（署名対象 canonical core）と `problemContentHash = SHA-256(平文)`—を**壊さない / 再実装しない**。
- 試験モードのセッション構造は ADR-0010 で **「1問1タブ・源流ロック」** と定めている。

## Considered Options

スターターコードを**どこに置くか**の比較（A〜C）。

### Option A: manifest の平文（cleartext）フィールドに `files[]` を足す
- Pros: 実装が単純（解錠不要で読める）。
- Cons: **T0 前にスターターコードが漏れる**（封印の意味を破る）。`files` を canonical core に入れるか否かで `packageHash`/署名の意味論を再設計する羽目になる。**却下**。

### Option B: 封印される**平文ペイロードを構造化ドキュメントにする**（★採用）
平文を「生 markdown 文字列」から、バージョン付き JSON へ拡張する:
```jsonc
{ "schema": "tcexam-problem/1",
  "statement": "# 問題1 …(markdown)…",
  "files": [ { "filename": "main.c", "language": "c", "content": "/* TODO */" } ] }
```
- Pros: スターターコードが**封印の内側**に入り T0 まで秘匿。**暗号コアは無改変**で、`packageHash`（署名）と `problemContentHash` が平文文字列を覆うので**スターターコードまで自動的に署名・内容束縛**される。既存の `TemplateFileDefinition` と `TemplateImporter`（多タブ生成 + 注入イベント記録）を**再利用**でき、2機能がコードレベルで1本化する。後方互換は schema 判別で担保（非 JSON / schema 無し → 従来の生 markdown 問題文、files=[]）。
- Cons: 平文の符号化契約（encode/decode）を**単一真実源**として shared に置き、authoring（封印）と editor（解錠）で一致させ続ける必要がある。`problemContentHash` がコード整形（空白・改行）に敏感になる（正準化方針が要る）。

### Option C: 第2の封印 blob を別に持つ（問題文とは別に template を独立封印）
- Pros: 問題文とテンプレートを別鍵/別タイミングで扱える。
- Cons: 暗号面が二重になり KDF/IV/署名対象が増える。単一 T0・単一問題の運用では**冗長**。**却下**。

## Decision

**Option B を採用する。**封印される平文を、バージョン付き構造化ドキュメント `tcexam-problem/1`（`statement` markdown + `files[]`）にし、後方互換のため schema 未判別の平文は従来の生 markdown 問題文として扱う。決め手は **暗号コアを一切変えずに（`packageHash` 署名 + `problemContentHash` 内容束縛がそのまま全ペイロードを覆う）**、既存テンプレート機構を再利用して2機能を統合できること。

確定する設計点:

1. **平文符号化は shared の単一真実源**。`exam/` に `encodeExamProblemPayload` / `decodeExamProblemPayload` を置き（`buildExamPackage` と同じ「authoring と verifier が共有する唯一の実装」方針）、authoring の封印前と editor の解錠後が同じ符号化を使う。`decode` は **untrusted JSON → 構造検証 or legacy fallback**。
2. **テンプレートモデルを再利用**。`files[]` は既存 `TemplateFileDefinition`（filename / language / content）。解錠後、`files` があれば `TemplateImporter` 相当の多タブ生成を **examContext 束縛つき**で回し、各タブに `templateInjectionEvent` を記録する。
3. **多タブの exam 束縛**。各テンプレートファイルは**編集可能な exam 束縛タブ**になる（各タブが自分のチェーンを持ち、genesis 根 = `SHA-256(fingerprintHash ‖ localNonce ‖ packageHash ‖ startToken)` で**同一 packageHash + 監督コード**に束縛）。`localNonce` はタブ毎に異なるので根は各タブで一意だが、全タブが同一封印に束縛される。grader（`verifyExamBinding`）は ZIP 内の各 proof を従来どおり検証する。これは ADR-0010 の「1問1タブ」を **「1問 N タブ（テンプレート由来）」へ拡張**する（源流ロックは N タブ生成後に施錠）。
4. **authoring（`/author`）の拡張**。AuthorPage にスターターコード入力（最小: 単一ファイル、フル: 複数ファイル / 既存 `.yaml` テンプレートの取込→封印）を足す。`allowed.languages` は `files` の言語と整合させる（少なくとも矛盾を弾く）。
5. **段階導入**。schema は最初から `files[]`（複数）を表現できる**上位互換**で固定し、実装は「単一ファイル → 複数ファイル」へ段階的に進めてよい（schema 変更を伴わない）。

## Consequences

### Positive
- スターターコードが**封印・署名・内容束縛**の内側に入り、追加の暗号設計なしで配布できる。
- テンプレート機能に**配布チャネル**（署名付き `.tcexam`）が生まれ、問題機能に**スターターコード**が入る。コードも `TemplateImporter` 再利用で重複が減る。
- 後方互換：既存の生 markdown `.tcexam` はそのまま解錠・表示できる。

### Negative / Trade-offs
- 平文符号化（encode/decode）が新たな**単一真実源**になり、ズレると解錠・検証が壊れる（`buildExamPackage` と同じ運用規律で守る）。
- `problemContentHash` がコード整形に敏感。**符号化前に正準化**（例: JSON の決定的シリアライズ、改行コード正規化）を定義し、authoring/editor/grader で一致させる。
- ADR-0010 の「1問1タブ」前提に触れるコード（タブ生成・源流ロック・リロード復帰）を N タブへ一般化する必要がある。

### Follow-ups / 残課題
- 実装フェーズ: (1) shared に payload codec + 後方互換 + 正準化 + テスト → (2) editor 解錠を `TemplateImporter` 再利用へ（多タブ exam 束縛・リロード復帰・源流ロックの N タブ化） → (3) `/author` にスターター入力（最小→フル）。
- `.yaml` テンプレート ↔ `tcexam-problem` payload の相互変換（教員が既存テンプレートをそのまま封印できる導線）。
- ProblemPanel は `statement` を表示（現状の plaintext 表示を構造化 payload に対応させる）。
- system-spec.md と shared/editor の CLAUDE.md に payload schema を明記。

## References

- 関連コード: [packages/shared/src/exam/examPackage.ts](../../packages/shared/src/exam/examPackage.ts)（`buildExamPackage` / `decryptExamPackage` / `computeProblemContentHash`）、[packages/shared/src/types/exam.ts](../../packages/shared/src/types/exam.ts)、[packages/shared/src/types/template.ts](../../packages/shared/src/types/template.ts)、[packages/editor/src/template/TemplateImporter.ts](../../packages/editor/src/template/TemplateImporter.ts)、[packages/editor/src/ui/components/ExamStartGate.ts](../../packages/editor/src/ui/components/ExamStartGate.ts)、[packages/editor/src/authoring/](../../packages/editor/src/authoring/)
- 関連 ADR: [ADR-0006](0006-exam-mode-sealed-problem-binding.md)（封印・束縛）、[ADR-0010](0010-exam-session-model.md)（1問1タブ → 本 ADR で N タブへ拡張）、[ADR-0011](0011-course-modes-and-path-routing.md)（モード体系）
- 関連 issue / PR: #80（出題者オーサリング）、#87 / #88（authoring seam / UI）
