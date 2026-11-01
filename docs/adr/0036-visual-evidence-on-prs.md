# ADR-0036: UI を変えた PR は本文に before/after の画像を載せ、素材は撮影専用の @shots spec で撮る

- **Status**: Accepted
- **Date**: 2026-11-01
- **Deciders**: @shinyaoguri
- **PR / Commit**: (#391。続けて #392 / #393)

## Context

editor / verify の見た目・動きを変えた PR に、何がどう変わったかの記録が残っていない。

- 直近に merge された 40 件のうち、editor / verify の UI に触れた 9 件 (#386 #384 #348 #363 #369 #318 #367 #277 #356) の本文に、画像が 1 枚も無い
- main は squash merge のみなので、**PR 本文がその変更の唯一の記録**になる。deploy-preview の URL は後から消え、fork と dependabot の PR にはそもそも出ない。レビューでも見た目の差を確かめる手段が「プレビューを開いて探す」しかない
- E2E は見た目を画素で比べない ([ADR-0034](0034-replace-manual-verification-with-automated-tests.md))。UI の振る舞いは data-* の状態契約で機械検査するが、見た目そのものの正しさの担い手は人の目である。人の目に見せるものを安く用意する道具と規律が無い

## Considered Options

### Option A: 規律だけ置き、撮影は各自の手作業に任せる
- Pros: 仕組みが増えない
- Cons: 撮る画面・言語・画面幅が人によって変わり、before と after が比べられない。手間が掛かるので省かれる (実際に 9 件すべてで省かれている)

### Option B: 画素比較 (visual regression) をゲートにする
- Pros: 見た目の差を機械が検出する
- Cons: ADR-0034 で不採用にした理由 (OS 差・フォント差で揺れる、基準画像の更新を誰がいつ承認するかの運用コスト) がそのまま残る

### Option C: 撮影専用の spec で同じ条件の画像を撮り、人が見る証跡として PR 本文に載せる
- Pros: 手元でも CI でも同じコマンドで同じ画面が撮れるので、base と head を並べれば before/after になる。合否を画像に委ねないので、画素比較の運用コストを負わない
- Cons: 撮影 spec の保守が要る。画像の置き場が要る

## Decision

Option C を採る。

1. **人が見る証跡であって、オラクルではない**。撮った画像で合否を出さない (画素比較をしない = ADR-0034 と整合)。撮影 spec (`packages/e2e/tests/shots.spec.ts`、タイトルに `@shots`) は何も assert せず、通常の E2E と CI のシャードからは外す。手元では `npm run shots -w @typedcode/e2e`
2. **撮影は @shots spec が正本**。何を撮ったかは spec が書き出す `shots/manifest.json` (`[{file, caption}]`) に書き、ファイル名は連番で固定する。CI はこの manifest を読んで base と head の同じ `file` を対にする。base と head で同じ画面になるよう、言語 (`ja-JP`)・タイムゾーン・配色・画面幅を固定し、撮るたびに変わる要素 (時計・ハッシュ) は mask で隠す
3. **置き場は Gyazo で、リポジトリにコミットしない**。画像は Gyazo へ上げて URL を PR 本文に貼る (repo-standards プラグインの gyazo-capture スキル)。`shots/` は gitignore する
4. **動きは可逆のアニメーション WebP**。GIF は 256 色に落ちて文字やアンチエイリアスが崩れるので使わない。コマ撮りを `img2webp` で可逆のまま束ね、大きすぎるときだけ近似可逆に落とす
5. **Gyazo が使えないときは GitHub の添付へ退避する** (gyazo-capture スキルの「E」の手順)。証跡を載せないことの言い訳にはしない
6. **欠落ゲートと CI の自動コメントを続けて入れた**: UI に触れた PR の本文に画像が無ければ落とすゲート (#392、`pr-checks.yml` の `require-visual-evidence`) と、CI が base と head で同じ spec を撮って before/after の表を PR に自動でコメントする仕組み (#393、`.github/workflows/visual-evidence.yml`)。後者の要点:
   - **base は merge commit (`refs/pull/N/merge`) の第一親**。head が「いまの main + この PR」なので、merge-base (分岐時点の main) と比べると、分岐後に main へ入った無関係な差が before/after に混ざる
   - **PR のコードを走らせる job (撮影) とトークンを触る job (Gyazo へ上げてコメントする) を分ける**。npm ci の install script などは `$GITHUB_ENV` / `$GITHUB_PATH` に書いて同じ job の後続 step を乗っ取れるので、撮影 job にはシークレットを渡さず artifact だけを出し、コメントする job は checkout せずトークンを 1 step にだけ渡す
   - **トークン (リポジトリシークレット `GYAZO_ACCESS_TOKEN`) が無ければ notice を出して緑で終わる**。fork と dependabot の PR は最初から対象外。証跡は在れば助かるもので、無いことは PR を止める理由にならない (本文の画像の有無は #392 のゲートが見る)
   - **必須チェックにしない**。変更ファイルで skipped になりうるワークフローを ruleset の必須にすると、走らなかった PR が「待ち」のまま止まる。コメントは同じ PR では 1 件を上書きし (マーカー `<!-- visual-evidence -->`)、作者はそこから本文の「見た目の証跡」へ写す (数えられるのも squash 後に残るのも本文だけ)

規律はルートの AGENTS.md「開発フロー」、CONTRIBUTING.md の完了の定義、PR テンプレートの「見た目の証跡」節に置く。PR テンプレートの例の画像記法は HTML コメントの中にだけ置き、テンプレートの文面だけで #392 のゲートを通らないようにする。

## Consequences

### Positive
- UI を変えた PR に、何がどう変わったかが画像で残る (squash 後も PR 本文から辿れる)
- before と after が同じ条件で撮れるので、レビューで差が読める
- 画素比較の基準画像を持たないので、OS 差・フォント差で CI が揺れない

### Negative / Trade-offs
- 撮影 spec は assert しないので、撮る画面が壊れても (例: 期待した状態に着く前に撮った) 緑のまま。画像を見る人が気付くしかない
- 画面を足すと PR コメントに縦に並ぶので、撮る画面は「PR で見たいもの」に絞る必要がある
- WebP の束ねに `img2webp` (libwebp) が要る。無い環境では WebP だけ飛ばす
- 外部サービス (Gyazo) に依存する。障害時は GitHub の添付へ手で退避する

### Follow-ups / 残課題
- なし (#392 / #393 は入れた。人がやること: リポジトリシークレット `GYAZO_ACCESS_TOKEN` の登録。無い間は #393 のコメントが出ないだけで、CI は止まらない)

## References

- `packages/e2e/tests/shots.spec.ts` / `packages/e2e/playwright.config.ts` (`grepInvert`)
- `scripts/require-tests.mjs` (`isShotsSpec`: 撮影 spec はテストに数えない) / `scripts/require-visual-evidence.mjs` (#392)
- `.github/workflows/visual-evidence.yml` (#393: base と head を撮って before/after をコメントする)
- [ADR-0034](0034-replace-manual-verification-with-automated-tests.md) (画素比較をしない)
- #391 / #392 / #393
