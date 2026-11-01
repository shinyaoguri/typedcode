**要約**: <!-- 3 行以内。何が変わり、どこまで確かめたか。人はここで読み止める -->

**人が判断すること**: <!-- 無ければ「なし」。あれば何を選ぶかと推奨を 1 行で -->

## 目的

<!-- なぜこの変更をするか。閉じる Issue は下の「Test plan」の小見出しに Closes #N で書き、ここには重ねて書かない -->

## Test plan

<!--
完了の定義は CONTRIBUTING.md「完了の定義 (Definition of Done)」/ ADR-0034。
目標は「CI が緑なら手動確認は不要」。手で確かめたことは下の「手動で確認したこと」へ。
-->

- [ ] `npm run check:fast` — typecheck / lint / カバレッジ付きユニットテスト (CI の test・check と同じ)
- [ ] `npm run test -w @typedcode/e2e` — E2E (UI の振る舞いを変えた場合。CI の e2e と同じ)
- [ ] カバレッジが上がったなら `npm run coverage:ratchet` で床を引き上げた

<!--
閉じる Issue ごとに "### Closes #N" の小見出しを立て、受け入れ条件と「何でどう確かめたか」を並べる (AGENTS.md「Issue と着手」/ ADR-0035)。
受け入れ条件は Issue 本文の番号や短い言い換えで指せばよく、文を書き写さなくてよい。
「着手時の現況」は着手時のプランの判定 (まだ有効 / 既に満たされている / 差し替えた) を写す。
GitHub はこの小見出しの "Closes #N" で Issue を紐づけ、merge で閉じる (squash merge ではコミット側の記述は GitHub に届かないので、本文に書く)。
まとめて閉じるなら小見出しを Issue の数だけ立てる。Issue を閉じない PR は小見出しごと消す。
-->

### Closes #N

| 受け入れ条件 | 着手時の現況 | 確かめたこと (テスト名・コマンド) |
|---|---|---|
| 条件 1 | まだ有効 | `packages/.../foo.test.ts` の「...」 |

### 自動化できず手動で確認したこと

<!-- 無ければ「なし」。ある場合は、確認した内容と自動化できない理由を書く (例: 画素レベルの見た目)。 -->

- なし

## 見た目の証跡

<!--
editor / verify の見た目・動きを変えた PR は、ここに before/after の画像を載せる (ADR-0036)。
見た目が変わらないなら、この節に「なし」と書く。見た目に効くパスを変えて本文に画像が無いと CI の
require-visual-evidence が落とすので、そのときは見た目が変わらない理由をここに書いてラベル `no-visual-change` を付ける。
- 画像はリポジトリにコミットせず、Gyazo へ上げて URL を貼る (repo-standards プラグインの gyazo-capture スキル)
- 動きはアニメーション WebP (GIF にしない)。素材は `npm run shots -w @typedcode/e2e` で packages/e2e/shots/ に撮れる
  (before は main で同じコマンドを打つ)。UI に触れた PR には CI (visual-evidence) が before/after をコメントするので、ここへ写す

例:

| before (main) | after (this PR) |
|---|---|
| <img src="https://i.gyazo.com/<id>.png" width="420"> | <img src="https://i.gyazo.com/<id>.png" width="420"> |
-->

## テスト不要の理由

<!--
該当時のみ記入。実装 (packages/*/src) を変えてテストを変えていない PR は CI の require-tests が落とす。
テストが本当に不要なら、ラベル `no-test-needed` を付け、この見出しの下に理由を書く (HTML コメントは数えない)。
該当しなければこの節は空のままでよい。
-->

## Documentation impact

<!--
本プロジェクトは「事実は 1 箇所にしか書かない」方針です。
コード変更が以下の領域に影響する場合は、対応するドキュメントを **同じ PR で** 更新してください。
該当しない項目は外してください。
-->

- [ ] **不変条件 / 責務を変えた** → 該当する `packages/*/AGENTS.md` を更新した
- [ ] **設計判断をした** (アルゴリズム選択 / 互換性方針 / フォーマット決定 / 責務分担) → `docs/adr/` に ADR を追加した
- [ ] **公開仕様 (定数の意味、アルゴリズム、エンドポイント) を変えた** → `docs/system-spec.md` を更新した
- [ ] **公開 API を変えた** → 該当パッケージの README を更新した
- [ ] **環境変数 / シークレット / KV / Secrets を追加した** → 該当 AGENTS.md と README を更新した
- [ ] 上記いずれも該当なし

注: **定数の値そのもの** (例: `POSW_ITERATIONS = 10000`) はソースが唯一の真実なので、ドキュメントには値を直書きしない方針です。値ではなくシンボル名で参照してください。

## ADR (該当する場合)

<!-- 新しい ADR を追加した場合、ファイル名と要約を記載。 -->

- [ ] N/A
- ADR-NNNN: ...

## Related issues / PRs

<!-- 閉じない関連の issue や PR の番号 (閉じる Issue は「Test plan」の Closes #N 小見出しへ)。 -->

---

<details>
<summary>Reviewer 向けチェック</summary>

- [ ] 変更されたサブシステムの `packages/*/AGENTS.md` を読み、PR の変更が不変条件と整合するか確認した
- [ ] 「なぜ?」が ADR またはコミットメッセージで説明されているか確認した
- [ ] 破壊的変更がある場合、`PROOF_FORMAT_VERSION` / `STORAGE_FORMAT_VERSION` の bump を検討した
- [ ] ドキュメント内に定数の **リテラル値** が書かれていないか確認した (シンボル名のみで参照する方針)

</details>
