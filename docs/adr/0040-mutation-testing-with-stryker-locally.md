# ADR-0040: 変異検査の道具 (StrykerJS) を、shared の検証系に対する手元のコマンドとして常設する

- **Status**: Accepted
- **Date**: 2026-11-03
- **Deciders**: @shinyaoguri
- **PR / Commit**: (#467 を閉じる PR)

## Context

[ADR-0037](0037-see-red-before-trusting-new-tests.md) は、新しいテストを「壊して赤を見てから仕上げる」規約にした。ただし手作業の自己申告で、取りこぼしは見えない。そこで Option C (実装を 1 か所ずつ機械的に壊し、テストが赤くなるかを測る変異検査) は、AGENTS.md「新しい仕組みは実害を示せるときだけ足す」に従い、typedcode で実害を測ってから入れるかを決めると先送りした (#467)。

#467 の段 1 で、`packages/shared` の検証系 5 ファイル (`verification.ts` / `typingProof/ChainVerifier.ts` / `fileProcessing/zipBudget.ts` / `utils/hashUtils.ts` / `typingProof/InputTypeValidator.ts`) に StrykerJS を一時的に当てた (2026-11-02、コミットなし)。

- 変異は 1268 件。killed 607 / survived 256 / timeout 19 / no coverage 386
- survived のうち、同値変異 (振る舞いが変わらない) が約 95 件、報告の値だけが変わるものが約 40 件、**検証の判定が変わるのにテストが捕まえない「テスト不足」が約 120 件**
- テスト不足のうち約 50 件は**改ざんを通す向き**だった。たとえば root アンカーの照合 (`verification.ts` の `rootUsedByEvents !== expectedInitialHash`) や full モードの PoSW 検証を外しても、shared・verify-cli・verify のテストは緑のままだった。申告したメタデータ (貼り付け回数など) の照合、署名 cp の判定、`zipBudget.ts` の予算超過時の停止も同じ
- `packages/shared/AGENTS.md` の不変条件が「緩めると zipBudget.test.ts が止める」と書く箇所も、実測では止まらなかった

実害が出たので、道具を入れる根拠は満たされた。生き残りを殺すテストは #496 / #498 〜 #502 で追う。この ADR は道具の置き方を決める。

制約:

- shared のテストには、verify-cli の fixture を相対パス (`../verify-cli/src/__tests__/fixtures/...`) で読むものがある (#417)。Stryker の既定の sandbox (`.stryker-tmp` へのコピー) では、変異前から ENOENT で赤になる
- 1 回の実行に数分かかる
- 同値変異は消せず、常に約 95 件残る

## Considered Options

### Option A: StrykerJS を CI (PR ゲート・nightly・週次) に載せる

- Pros: 点数が自動で記録され、下がれば気付ける
- Cons: 同値変異が常に残るので、点数は「読む人のいない数字」になりやすい。数分かかり、PR ゲートにすると遅い。点数で merge を止めると、同値変異の判定が人の手に戻る。AGENTS.md「新しい仕組みは実害を示せるときだけ足す」に対し、定期計測の実害 (点数が下がって困った) はまだ無い

### Option B: 自作スクリプト (mokume の `scripts/mutate.py` 相当) で変更行だけを壊す

- Pros: 依存が増えない。演算子と範囲を自分で決められる
- Cons: 演算子の網羅・同値変異の除去・テストとの対応づけ (`perTest` のカバレッジ解析) を自前で持つことになる。段 1 で Stryker が vitest 5 と組み合わせて動くことを確かめ済みで、作り直す理由が無い

### Option C: StrykerJS を `packages/shared` の devDependencies に入れ、手元のコマンドとして常設する (採用)

- Pros: 演算子・範囲指定・テスト対応づけを道具に任せられる。書いた本人が、変更行に絞って数分で回せる。CI を増やさない
- Cons: 回すかどうかは作者の規律に依存する (強制しない)。devDependencies と lockfile が増える

## Decision

**Option C** を採る。ADR-0037 の Option C を、次の形で採る。

1. **道具**: `@stryker-mutator/core` と `@stryker-mutator/vitest-runner` を `packages/shared` の devDependencies に入れる。`npm run mutate -w @typedcode/shared` で回す
2. **対象**: `packages/shared/stryker.config.json` の `mutate` が正本で、docs には書き写さない。段 1 で測った検証系の 5 ファイルから始める
3. **判定**: shared のテストだけで行う。shared の検証ロジックは shared のテストで守る、という既存の分担 ([packages/shared/AGENTS.md](../../packages/shared/AGENTS.md)) に合わせる。verify-cli / verify のテストをまたいだ判定はしない
4. **`"inPlace": true`**: 手元のソースを直接書き換えて回し、終了時に元へ戻す。sandbox のコピーでは #417 の fixture が読めないため。作業ファイルは gitignore する
5. **手元のコマンドだけ**: CI (PR ゲート・nightly・定期計測) にも、`npm run check` / `check:fast` にも載せない。理由は、数分かかること、同値変異が常に残って点数が読まれる数字にならないこと
6. **運用**: 対象のファイルを変えた PR の作者は、変更行に絞って回す (範囲の書式は [CONTRIBUTING.md](../../CONTRIBUTING.md) の「変異検査」)。生き残った変異は、テストを足して殺すか、同値変異と判断した理由を PR の対応表に書く
7. 点数で merge を止めることはしない

## Consequences

### Positive

- 「壊しても緑のテスト」が件数と箇所で見える。ADR-0037 の手作業の取りこぼしを拾える
- 変更行に絞れるので、PR の作者が数分以内に回せる

### Negative / Trade-offs

- 強制しないので、回し忘れは気付かれない。回していない PR の実害が出たら、ゲート化 (Option A) を新しい ADR で検討する
- `inPlace` なので、実行中にソースを編集してはならず、途中で止めるとソースに変異が残りうる。終了後は `git status` で確かめる
- 同値変異は消えない。survived を読む人が、判定が変わるものだけを拾う必要がある
- 対象は shared の 5 ファイルだけ。verify-cli・editor・E2E は測っていない

### Follow-ups / 残課題

- 生き残り (テスト不足) を殺すテスト: #496 / #498 / #499 / #500 / #501 / #502
- 点数が下がって困る実害が出たら、定期計測 (Option A) を再検討する

## References

- [ADR-0037](0037-see-red-before-trusting-new-tests.md) — 新しいテストは壊して赤を見る (本 ADR は Option C を採るもの)
- [ADR-0034](0034-replace-manual-verification-with-automated-tests.md) — カバレッジの床 (検証力は見ない)
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — 完了の定義・変異検査
- `packages/shared/stryker.config.json`
- Issue #467 (段 1 の測定・決定) / #466 (規約の側)
- [StrykerJS](https://stryker-mutator.io/)
