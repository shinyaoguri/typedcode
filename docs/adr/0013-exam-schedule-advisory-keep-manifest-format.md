# ADR-0013: 試験スケジュール (releaseTime/deadline) を advisory とし、manifest フォーマットは据え置く

- **Status**: Accepted
- **Date**: 2026-06-09
- **Deciders**: (PR 上の合意者 / レビュアー)
- **PR / Commit**: #NN

## Context

`.tcexam` manifest (ADR-0006, §4.7) は `releaseTime` (試験開始 T0) と `deadline` (提出期限 T1) を持ち、両者は **signing core に含まれ署名・packageHash に焼かれる**。

オーサリング運用を見直した結果、**開始/締切の管理は Moodle 側で行い、TypedCode 側は「いつ解いたか」(proof のタイムスタンプ・署名チェックポイントの serverTimestamp) を記録できれば十分**という方針が確定した (`/author` UI からスケジュール入力欄を撤去済み)。

ここで「manifest からも release/deadline を消す (フォーマットを変える) べきか」を検討する。両フィールドの実際の用途は非対称:

- **`releaseTime`**: スケジュール表示だけでなく **出題者鍵の有効性アンカー**。`checkExamKeyValidityAtRelease` が「`releaseTime` 時点で鍵が有効/未失効だったか」(validFrom / validUntil / revokedAt) を判定する。これは**スケジュールと独立した正当な意味**を持ち、実体は **issued-at (パッケージ発行時刻)**。
- **`deadline`**: 用途は `verifyExamBinding` の **advisory な time-box のみ** (`withinWindow` は grader が提出時刻を渡したときだけ判定し、それ以外は無視。失格条件にはしない)。**純粋にスケジュール専用**。

## Considered Options

### Option A: フォーマット据え置き（★採用）
`releaseTime`/`deadline` を必須のまま残し、UI は内部既定 (releaseTime=生成時刻, deadline=オープン=遠い未来) を入れる。意味づけを文書で確定する。
- Pros: **横断的変更ゼロ**。`releaseTime` の鍵有効性アンカーを失わない。verifier は optional 分岐を持たず単純なまま。既存 `.tcexam` と完全互換。
- Cons: `deadline` が advisory な vestigial フィールドとして残る。「オープン」を遠い未来 (`2999-12-31`) のセンチネルで表すのは多少の匂い。

### Option B: `deadline` を optional 化する (formatVersion 2)
- Pros: 「スケジュールは Moodle が正」を型でも表現でき意味論が綺麗。
- Cons: **signing core 変更 → `EXAM_PACKAGE_FORMAT_VERSION` bump**、`verifyExamBinding` / `parseExamPackageManifest` / verify(web) / verify-cli / 後方互換の横断改修。得られるのは advisory な 1 フィールドの除去のみで、**リスク/便益が見合わない**。`releaseTime` は鍵アンカーとして引き続き必須。

## Decision

**Option A を採る。** manifest フォーマットは変更しない。意味づけを以下に確定する:

- **`releaseTime` = パッケージ発行時刻 (issued-at) かつ出題者鍵有効性アンカー。** 必須。`/author` は生成時刻を入れる。
- **`deadline` = advisory な提出窓の上限。** 必須だが**規範ではない** — 実際の開始/締切の管理は **Moodle が唯一の正**。Moodle 管理時は **オープン (遠い未来) を入れる** (`/author` は `2999-12-31T23:59:59.999Z`)。`verifyExamBinding` の time-box は引き続き advisory (失格条件にしない)。
- 「いつ解いたか」は proof 側 (イベントのタイムスタンプ、署名 cp の serverTimestamp) が担う。

将来どうしても `deadline` を optional 化したくなったら、独立した formatVersion 2 の ADR で扱う (現時点は不要)。

## Consequences

### Positive
- 横断改修ゼロ・既存パッケージ完全互換。`releaseTime` の鍵有効性検証 (defense-in-depth) を維持。
- スケジュール責務が明確化 (Moodle が正、TypedCode は記録のみ)。

### Negative / Trade-offs
- `deadline` が advisory な必須フィールドとして残り、「オープン」をセンチネル日付で表す。
- verifier の time-box 出力に「advisory」である旨が伝わるかは UI 表示次第 (既存の繰り越し課題)。

### Follow-ups / 残課題
- system-spec §4.7 に releaseTime=issued-at/アンカー・deadline=advisory(Moodle が正) を明記 (本 ADR と同時)。
- (将来・任意) `deadline` optional 化を formatVersion 2 で検討。

## References

- 関連コード: [packages/shared/src/exam/examPackage.ts](../../packages/shared/src/exam/examPackage.ts)（`checkExamKeyValidityAtRelease` / `verifyExamBinding` の time-box）、[packages/shared/src/types/exam.ts](../../packages/shared/src/types/exam.ts)（`ExamPackageManifest`）
- 関連 ADR: [ADR-0006](0006-exam-mode-sealed-problem-binding.md)（封印・束縛 — release/deadline を定義）、[ADR-0012](0012-sealed-starter-template-in-exam-payload.md)（N問バンドル）
- 関連 issue / PR: #80、#92（`/author` スケジュール撤去）
