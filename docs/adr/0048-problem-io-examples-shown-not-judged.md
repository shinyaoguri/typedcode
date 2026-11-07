# ADR-0048: 問題に入出力例を持たせ、受講者には判定せず見せるだけにする (段階 1)

- **Status**: Accepted
- **Date**: 2026-11-07
- **Deciders**: @shinyaoguri
- **PR / Commit**: (#648 を閉じる PR)

## Context

課題・試験で「仕様どおりに動くか」を受講者が確かめる手がかりが、問題文の中の入出力例しか無かった。問題文は Markdown なので書き方が問題ごとにばらつき、入力と出力の対の書き忘れも起きる。

当初の #648 は、問題に公開テストケースを持たせ、editor の「テスト」ボタンで自動実行して ✓/✗ を出し、結果を proof に記録する設計だった。メンテナとの議論 (#648 の 2026-11-07 のコメント) で、受講者への見せ方を変えた。初学者向けの課題では、受講者が「テストとは何か」をまだ知らないことがある。提出前のチェックとして例を見せ、自分でコンパイル・実行し、入力を打って出力を見比べてもらう。

前提として、Python の `input()` がターミナルから入力を読めるようにした (#649 / ADR-0047)。C / C++ は以前からターミナルの stdin を受け取れる。

## Considered Options

### Option A: 問題文 (Markdown) に書いてもらう (何も足さない)

- Pros: 形式の変更が要らない
- Cons: 書き方がばらつき、入力と出力の対が崩れても気付けない。コピーボタンのような受講者向けの補助を付けられない。教員側で再実行して採点する段階 2 の素材にもならない

### Option B: 公開テストケースとして自動実行・自動判定する (当初の #648)

- Pros: 通ったかどうかが一目で分かる。「初めて全ケースが通った時刻」を過程のデータとして残せる
- Cons: 初学者には「テスト」という枠組み自体が説明を要する。比較規則 (改行・末尾空白) の説明も要る。受講者が自分で実行して見比べる学びを、ボタン 1 つが置き換えてしまう。実行器に stdin を一括で流し込む改修 (C のコンパイル回数、Python の stdin) も要る

### Option C: 構造化した入出力例を問題に持たせ、判定せず表示する

- Pros: 表示がそろい、`/author` が入力と出力の対を書かせる。受講者は自分で実行し、自分で見比べる。実行器の改修が要らない。同じ形を段階 2 の非公開テストにも使える
- Cons: 「いつ全部通ったか」は記録されない。見比べの誤り (空白・改行の違いの見落とし) は受講者に任される

## Decision

**Option C を採る。**

1. **形**: `ExamBundleProblem.examples?: { name, stdin, stdout }[]`。言語に依存せず、教員にとっても「入出力例」そのままの形。データの名前を `tests` にしない。UI でも「テスト」という語を使わず、「入出力例」「動作確認の例」と書く
2. **判定しない**: ✓/✗・差分の表示・比較関数は editor に持たない。出力の比較規則は、教員側で再実行して採点する段階 2 で決める
3. **表示**: 問題パネルの問題文の下に「動作確認の例」の節を置き、手順を 1 行添える (▶ 実行 → 入力例をターミナルに打つか貼る → 出力が同じか見比べる)。入力にはコピーボタンを付ける。打ち間違いでつまずかせないためで、手で打つこともできる。入力を自動で流して出力と並べるボタンは作らない (実行も入力も受講者が行う)
4. **proof に新しい記録を足さない**: 表示とコピーは記録しない。受講者が自分で実行した分は既存の `codeExecution` に、ターミナルに打った・貼った入力は既存の `terminalInput` に載る。「いつ初めて全部通ったか」は取らない
5. **ハッシュ**: `examples` は問題の一部として正準化し、封印と `problemContentHash` の対象にする。1 件以上のときだけ正準形に含め、`examples` を持たない問題のハッシュを変えない。`stdin` / `stdout` の改行は、問題文と同じく LF に正規化してからハッシュする
6. **非公開テストは配布物に入れない**。`.tcexam` も解錠後は受講者が中身を読めるので、同梱した時点で公開と同じになる。段階 2 の非公開テストは配布物とは別のファイルで、同じ `{ name, stdin, stdout }` の形を使う
7. **三層保証 (ADR-0020) に混ぜない**。正しさの確認は著述性の判定 (ADR-0023) とは別の軸として扱う

## Consequences

### Positive

- 受講者は、問題ごとにそろった形で「この入力ならこの出力」を見て、自分で確かめられる
- `/author` が入力と期待する出力の対を書かせるので、問題文に書くより崩れにくい
- 実行器にも proof の形式にも手を入れない (`PROOF_FORMAT_VERSION` は据え置き)
- 段階 2 (教員側の再実行と採点) は、同じ形の別ファイルを読めばよい

### Negative / Trade-offs

- **入出力例付きの `.tcexam` は新しい editor が前提**。旧版の editor は `parseExamBundle` で `examples` を落とし、落としたままのハッシュを root に焼く。検証側は復号した平文から `examples` 入りで計算し直すので、`problemContentHash` が一致せず束縛が壊れる。`.tcclass` は root を束縛しないので影響しない
- コピーボタンは `SessionContentRegistry` に登録しない (登録すると `copyOperation` が proof に載る)。そのため、コピーした入力を受講者がコードエディタに貼ると、外部の貼り付けとして扱われる。入力例はターミナルに貼るもので、コードに貼る用途は想定しない
- 見比べは受講者の目に任される。末尾の空白や改行の違いは見落としうる

### Follow-ups / 残課題

- 段階 2: 非公開テストのファイル形式と、教員側の一括採点 (再実行・比較規則・CSV 出力) は別 Issue にする
- テンプレート取込 (`TemplateImporter`) から入出力例を読むことはしていない

## References

- `packages/shared/src/exam/examBundle.ts` (`parseExamBundle` / `canonicalProblem` / `computeBundleProblemHash`)、`packages/shared/src/types/exam.ts`
- `packages/editor/src/ui/components/ProblemPanel.ts`、`packages/editor/src/authoring/AuthorPage.ts`
- [ADR-0047](0047-python-in-dedicated-worker-with-terminal-stdin.md) (Python のターミナル入力)、[ADR-0012](0012-sealed-starter-template-in-exam-payload.md) (バンドルと問題ハッシュ)、[ADR-0014](0014-class-mode-unsealed-problem-distribution.md) (class パッケージ)、[ADR-0020](0020-three-layer-assurance-vocabulary.md)、[ADR-0023](0023-analysis-platform-not-judge.md)、[ADR-0021](0021-code-execution-result-capture.md)
- #648、#649、`docs/system-spec.md` §4.9
