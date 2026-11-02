# ADR-0038: PR は必ず Issue を閉じ、その紐づけは GitHub の closingIssuesReferences で検査する

- **Status**: Accepted
- **Date**: 2026-11-03
- **Deciders**: @shinyaoguri
- **PR / Commit**: (#478 を閉じる PR)

## Context

PR が閉じる Issue を機械が見ていない。そのため、作業が終わった Issue が開いたまま残る。

- merge 済みの PR 259 件のうち 159 件が Issue を閉じていない (dependabot 40 件を含む)。2026-10 以降も、dependabot を除く 14 件が閉じていない (#476 #473 #464 #438 #402 #407 #381 #365 #362 #357 #353 #352 #350 #349)
- **実害は #226**。受け入れ条件 4 項目は #402 で満たされた。ところが PR は「PR-B が残る」として `Refs #226` と書き、Issue は開いたまま残った。受け入れ条件は PR-B を最初から含めていなかった
- 段階に分けた PR が `Refs` で親 Issue を開いたまま積んでいる (#223 #305 #344 #333 #450 #332)。残作業は親のコメントに散らばり、Issue 一覧からは何が残っているか読めない
- PR テンプレートは `### Closes #N` を案内していた。しかし検査は無く、「Issue を閉じない PR は小見出しごと消す」という逃げ道もテンプレート自身に書いてあった

姉妹リポジトリ mokume は、同じ問題を `scripts/review-gate.sh` (pr-gate) で塞いでいる。その経緯で、本文を正規表現で照合する方式は、コードスパンに入れた `Closes #N` を通してしまった (GitHub はコードスパン・引用・打ち消しの中の closing keyword を紐づけない)。

## Considered Options

### Option A: 運用 (AGENTS.md の文言) だけで徹底する
- Pros: 仕組みが増えない
- Cons: 今もテンプレートが案内しているのに、14 件が抜けている。文書のルールは抜ける (ADR-0036 の画像と同じ構図)

### Option B: PR 本文の `Closes #N` を正規表現で検査する
- Pros: API 呼び出しが要らない
- Cons: 「書いたが GitHub が紐づけていない」形 (コードスパン・引用・別リポジトリの番号) を通す。守りたいのは文字列があることではなく、merge で Issue が閉じること

### Option C: GitHub が作った紐づけ (`closingIssuesReferences`) を読む必須チェック
- Pros: merge で閉じるかどうかを、GitHub 自身の答えで判定する。mokume での実績がある
- Cons: API を 1 回呼ぶ。受け入れ条件を持たない PR のために逃げ道が要る

## Decision

Option C を採る。`.github/workflows/pr-checks.yml` の job `require-issue` (判定は `scripts/require-issue.mjs`) を必須チェックにする。

1. 自リポジトリの Issue への紐づけが 1 件以上あれば pass。他リポジトリを指す紐づけは数えない
2. 例外はラベル `no-issue` と、author が `dependabot[bot]` の PR だけ。**型 (`docs` / `ci` / `chore`) では免除しない** — `require-tests` / `require-visual-evidence` と違い、閉じ忘れはその種の PR でも起きる (#362 は `ci`、#473 は `test`)
3. `no-issue` は、受け入れ条件を持たない PR (依存の手動更新・リリース準備・自動生成の取り込みなど) に使う
4. 段階に分けた作業は、段階ごとに sub-issue を切ってそれを閉じる。親を `Refs` で開いたままにしない

## Consequences

### Positive
- 「作業は終わったが Issue が開いている」が merge の前に止まる。Issue 一覧が残作業の一覧として読める
- 段階の境界が sub-issue として見えるので、残作業が親のコメントに散らばらない

### Negative / Trade-offs
- 段階 PR のたびに sub-issue を起票する手間が増える
- `no-issue` が逃げ道として濫用されうる。中身の妥当性はレビューの目で見る (ADR-0036 の画像の中身と同じ)

### Follow-ups / 残課題
- 閉じる Issue に `verify: triaged` が付いているかの照合 (mokume の review-gate の 2.) と、Test plan に Issue ごとの小見出しがあるかの照合 (同 3.) は、この ADR では足さない。足すのは、抜けによる実害を Issue 番号で示せたとき (AGENTS.md「新しい仕組みは実害を示せるときだけ足す」)
- 既存の段階 Issue (#223 #305 #344 #333 #450 #332) は、sub-issue に組み直さずに今の形で進める。次に手を付けるときに切る

## References

- `scripts/require-issue.mjs` / `scripts/require-issue.test.mjs` / `.github/workflows/pr-checks.yml`
- ADR-0034 (require-tests)、ADR-0035 (トリアージのゲート)、ADR-0036 (require-visual-evidence)
- #226 (実害)、#478
- mokume `scripts/review-gate.sh` の「1. 対象 Issue の解決」
