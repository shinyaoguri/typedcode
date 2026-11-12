# Contributing — 開発の進め方

TypedCode のブランチ運用は **タグ式 GitHub Flow** です。判断の根拠は [ADR-0028](docs/adr/0028-tag-based-github-flow.md) を参照。本ファイルは日々の**手順** (ブランチ運用・worktree 並行作業・マージ後の掃除・リリース) を扱います。

## 全体像

```
tags                v1.1.0        v1.2.0
                      ●             ●          ← リリース = v* タグ (→ production デプロイ・承認ゲート)
main     ●──●──●──●──●──●──●──●──●──●──●────   ← 唯一の長命ブランチ (push で staging 自動デプロイ)
          ╲  ╱   ╲  ╱      ╲  ╱
feature   ●─●    ●─●        ●─●               ← 機能ごとに切る (PR → main, squash)
```

| 対象 | 役割 | デプロイ |
|---|---|---|
| `main` | 唯一の長命ブランチ・常時統合 | push → **staging** 自動 (https://staging.typedcode.pages.dev) |
| `v*` タグ | 番号付きリリース | タグ push → **production** (承認ゲート付き。https://typedcode.dev) |
| `<type>/*` | 機能開発 (`feat/*`, `fix/*`, ...) | PR → preview URL 自動発行 |

公開先は GitHub からも開ける: PR 画面の「View deployment」(その PR の preview)、リポジトリのトップ右の Deployments 欄 (環境ごとの最新)、https://github.com/shinyaoguri/typedcode/deployments (環境ごとの履歴)。

- `develop` / `release/*` / `hotfix/*` ブランチは**ありません**。main が常にリリース候補です。
- **`staging` はブランチ名として予約** (staging Pages エイリアスと衝突するため使用禁止)。

## 普段の開発フロー

ブランチは `<type>/<短い説明>` で命名します。type は下記コミット型と同じものを使います (例: `feat/exam-timer`, `fix/posw-worker-race`, `docs/adr-0029`, `chore/ci-cache`)。

```bash
# 1. main 最新から worktree を作る (メインのチェックアウトは main のまま。詳細は「並行作業」)
git fetch origin
git worktree add .claude/worktrees/my-change -b feat/my-change origin/main
cd .claude/worktrees/my-change && npm ci

# 2. 作業してコミット (Conventional Commits: feat:/fix:/docs:/test:/refactor:/chore:/ci: ...)
git add -A
git commit -m "feat(editor): add foo"

# 3. push して PR を作る (base = main)
git push -u origin feat/my-change
gh pr create --fill

# 4. CI 通過 + セルフレビュー後、Squash and Merge → 掃除
gh pr merge --squash --delete-branch
```

- **PR は小さく** (目安 ±400 行)。1 PR = 1 つの関心事。
- **PR タイトルも Conventional Commits 形式にする**。Squash and Merge では PR タイトルがマージコミットのメッセージになります。
- マージ前に lint / type check / test / build が緑であること (main は required status checks で強制)。手元では `npm run check` で同じ検査を回せる。
- 「完了」の基準は下記「完了の定義」。**CI が緑なら手動の動作確認は不要**にすることが目標で、そのためにテストを足す。
- マージされると main push の CI が staging へ自動デプロイする。staging / production ともデプロイ直後に `scripts/post-deploy-check.mjs` がその deploy の不変 URL (alias・custom domain ではなく) で editor / verify の COOP・COEP、Worker の署名 readiness、Pages の Origin に対する CORS preflight を検査し、不備があれば deploy job を失敗させる (#579)。staging では続く `e2e-staging` job がその deploy の URL をブラウザで通す (打鍵 → 署名付き checkpoint → export → verify-cli と `/verify/`。#655)。staging は Turnstile の公開テストキーで動くので、本物の Turnstile は production でしか通らない ([ADR-0049](docs/adr/0049-staging-turnstile-testing-keys.md))。人が触って確かめるなら https://staging.typedcode.pages.dev で。
- **マージしたら、メインのチェックアウトから `git sweep` を実行して**ローカルブランチと worktree を掃除する (下記「マージ後の掃除」)。

## 完了の定義 (Definition of Done)

機能追加のたびに手で動作確認するのをやめ、「CI が緑なら手動確認は不要」を成り立たせるための基準です。判断の根拠は [ADR-0034](docs/adr/0034-replace-manual-verification-with-automated-tests.md)。

- **UI の振る舞いを変える / 足すなら E2E を 1 本以上** (`packages/e2e/tests/`)。検査には翻訳テキストや見た目ではなく、**生の enum 値・状態を出す `data-*` 属性** (状態契約) を使い、そのフックも同じ PR で実装に足す。証明に関わる振る舞いは、従来どおり verify-cli の結論をオラクルにする ([packages/e2e/AGENTS.md](packages/e2e/AGENTS.md))
- **ロジックはユニットテスト** (各パッケージの `__tests__/` か `*.test.ts`。書き方は [packages/shared/AGENTS.md](packages/shared/AGENTS.md) の「テスト規約」)
- **バグ修正は先に赤いテスト**: 再現するテストが落ちるのを確かめてから直す。すぐ直さない既知バグは E2E なら `test.fixme('#N ...')` で再現を置き、修正 PR で外す
- **新しいテスト・検査は壊して赤を見てから仕上げる** (バグ修正に限らない): 検証対象の振る舞いを一時的に壊すか直した行を戻して、そのテストが赤くなるのを確かめる。壊しても緑のままのテストは書き直す。何を壊して赤くなったかは、PR の受け入れ条件の対応表の「壊すと赤になるか」列に書く。カバレッジと `require-tests` はテストの検証力を見ないため ([ADR-0037](docs/adr/0037-see-red-before-trusting-new-tests.md))
- **変異検査の対象ファイルを変えたら、変更行に `npm run mutate` を回す**: `packages/shared/stryker.config.json` の `mutate` にあるファイル (対象の正本はそこ。検証系の数ファイル) を変えた PR は、変更行に絞って変異検査 ([StrykerJS](https://stryker-mutator.io/)) を回し、生き残った変異をテストで殺すか、同値変異 (振る舞いが変わらない変異) と判断した理由を PR の対応表に書く。道具は手元のコマンドだけで、CI にも `npm run check` / `check:fast` にも載せない (全体で数分かかり、同値変異が常に残る)。ADR-0037 の「壊して赤を見る」を機械でやるもので、カバレッジと `require-tests` が見ない検証力を測る ([ADR-0040](docs/adr/0040-mutation-testing-with-stryker-locally.md))。使い方は下の「変異検査」
- **カバレッジは下げない**: 各パッケージの `vitest.config.ts` の `coverage.thresholds` が実測値の床で、下回ると CI の test job が落ちる。**機能 PR では床を動かさない**。床は、main で週 1 回測る定期ジョブ ([coverage-ratchet.yml](.github/workflows/coverage-ratchet.yml)) が「上げられる値」を Issue で知らせるので、それを受けた専用の PR で、Issue の表の値 (CI と同じ環境の実測) を書いて上げる。手元の実測は CI を上回りうるので、手元の `npm run coverage:ratchet` の値をそのまま使わない ([ADR-0039](docs/adr/0039-raise-coverage-floors-in-dedicated-prs.md))
- **テストが本当に不要なら理由を書く**: 実装 (`packages/*/src`、ページエントリの `packages/*/*.html`、配信の振る舞いを変える設定 `packages/*/vite.config.ts`・`packages/*/public/_headers`・`packages/workers/wrangler*.toml`) を変えてテストを変えていない PR は、CI の `require-tests` ([pr-checks.yml](.github/workflows/pr-checks.yml)) が落とす。挙動を変えないリファクタなどでテストが不要な場合は、PR にラベル `no-test-needed` を付け、PR 本文の `## テスト不要の理由` 見出しの下に理由を書く (ラベル・本文の編集で再判定される)。依存更新の PR は対象外。`docs` / `ci` / `chore` 型が対象外になるのは実装を変えていない PR だけで、型の名乗りだけでは免除しない (#591)
- **見た目・動きを変えたら before/after を本文へ**: editor / verify の見た目・動きを変える PR は、PR 本文の「見た目の証跡」に before/after の画像 (動きはアニメーション WebP) を載せる。画像はコミットせず Gyazo へ上げて URL を貼る。素材は `npm run shots -w @typedcode/e2e` で撮れるほか、UI に触れた PR には CI ([visual-evidence.yml](.github/workflows/visual-evidence.yml)) が base と head で撮った before/after をコメントするので、それを本文の「見た目の証跡」へ写す。見た目に効くパス (editor / verify の HTML・CSS・UI 部品) を変えて本文に画像が無い PR は、CI の `require-visual-evidence` ([pr-checks.yml](.github/workflows/pr-checks.yml)) が落とす。見た目が変わらない変更 (ロジック・data-* の追加など) なら、ラベル `no-visual-change` を付ける。`docs` / `ci` / `chore` 型でも、見た目に効くパスを変えていれば免除しない ([ADR-0036](docs/adr/0036-visual-evidence-on-prs.md))
- **PR は必ず Issue を閉じる**: PR 本文の Test plan の `### Closes #N` で GitHub が Issue を紐づけていない PR は、CI の `require-issue` ([pr-checks.yml](.github/workflows/pr-checks.yml)) が落とす。型 (`docs` / `ci` / `chore`) では免除しない。受け入れ条件を持たない PR だけラベル `no-issue` で通す (本文の編集・ラベルの付け外しで再判定される。dependabot の PR は対象外)。段階に分けた作業の扱いは [AGENTS.md の「Issue と着手」](AGENTS.md#issue-と着手) ([ADR-0038](docs/adr/0038-every-pr-closes-an-issue.md))
- **自動化できない確認は理由とともに残す**: 見た目の最終確認など、手で確かめたことは PR 本文の「自動化できず手動で確認したこと」に理由つきで書く
- **手元では `npm run check`** (typecheck → lint (Biome + docs の `[[...]]` 参照の検査) → workflow の検査 (`lint:workflows` = actionlint + shellcheck) → README の依存表と package.json の名前の突合 (`node scripts/check-deps.mjs`。依存の版は package.json が唯一の正で、README は名前と用途だけ) → カバレッジ付きユニットテスト → E2E)。E2E を除いた `npm run check:fast` もある

`scripts/` のテストのうち `*.test.mjs` (PR ゲートの `require-tests` / `require-visual-evidence` / `require-issue` など) と、e2e の環境準備とサーバ照合のテスト `packages/e2e/scripts/*.test.mjs` (`setup-env` / `server-identity`) は CI (check job) で `node --test 'scripts/*.test.mjs' 'packages/e2e/scripts/*.test.mjs'` として走る。`sweep.test.ts` は使い捨てのリポジトリを組み立てる統合テストなので CI 常設にはしておらず、スクリプトを変えたときに手元で回す (下記「マージ後の掃除」)。

## 変異検査 (StrykerJS)

実装を 1 か所ずつ機械的に壊し (`>=` → `>`、条件を `false` に、など)、テストが赤くなるかを測る。壊しても緑のまま生き残った変異 (survived) が、テストの足りない箇所を指す。判断の根拠は [ADR-0040](docs/adr/0040-mutation-testing-with-stryker-locally.md)。

```sh
# 設定にある全ファイル (数分)。ファイルごとの killed / survived / timeout / no coverage が端末に出る
npm run mutate -w @typedcode/shared

# 範囲を絞る (--mutate は設定の mutate を置き換える)。`ファイル:開始行-終了行`、1 行なら `ファイル:行`
npm run mutate -w @typedcode/shared -- --mutate 'src/verification.ts:100-150'
# 複数ファイル・複数範囲はコンマ区切り
npm run mutate -w @typedcode/shared -- --mutate 'src/verification.ts:100-150,src/utils/hashUtils.ts'
```

- パスは `packages/shared` からの相対 (`src/...`)。変更した範囲は `git diff -U0 <ファイル>` の `@@ -a,b +c,d @@` の `c` から `c+d-1` で分かる
- 判定は shared のテストだけで行う。作業ファイルは `packages/shared/.stryker-tmp/` に出て、終了時にソースは元に戻る (`inPlace`。verify-cli の fixture を相対パスで読むテストが sandbox のコピーでは動かないため)。**走っている間は対象のファイルを編集せず、同じ作業ツリーで別の変異検査も走らせない**
- `npm run mutate` は、`packages/shared/.stryker-tmp/` が既にあると変異を始めずに止まる (`scripts/stryker-guard.mjs`。実行中のものと重ねない・中断の残骸の上で回さないため。#600)。`npx stryker run` を直接打つとこの検査を通らないので、`npm run mutate` から回す
- **途中で止まったとき** (Ctrl-C の二度押し・プロセスの kill・マシンの停止): 元のファイルは `packages/shared/.stryker-tmp/backup-*/` に `packages/shared` からの相対パスのまま退避されている。走っていないこと (`pgrep -fl stryker` が何も出さない) を確かめてから、`cp -R packages/shared/.stryker-tmp/backup-*/. packages/shared/` で戻し、`git status` と `git diff` で変異が残っていないことを見てから `rm -rf packages/shared/.stryker-tmp` する。退避は実行前の作業ツリーそのもの (未コミットの変更も含む) なので、`git checkout` で戻すより確実
- 同値変異は常に残る (対象の件数や内訳は実行のたびに端末で見る)。読み方は「survived のうち、そのファイルの判定が変わるのに緑のもの」だけ拾う。殺すテストを足したら、ADR-0037 のとおり、足したテストが壊して赤くなることも確かめる
- 対象ファイルを増やす・減らすときは `packages/shared/stryker.config.json` の `mutate` を直す (docs には書き写さない)

## 並行作業 (git worktree)

作業はメインのチェックアウトでブランチを切り替えるのではなく、git worktree で並行作業します。リポジトリ直下は常に main のままにしておき、ブランチでの作業は worktree 側で行います。これにより、レビュー中に別タスクを並行で進めたり、main で動作確認しながらブランチを編集したりできます。Claude Code のセッションも同じ流儀で `.claude/worktrees/` 配下に worktree を作って動きます。

```sh
# 作成 (main 最新からブランチを切って .claude/worktrees/ 配下に展開)
git fetch origin
git worktree add .claude/worktrees/<name> -b <type>/<説明> origin/main
cd .claude/worktrees/<name>
npm ci

# ...編集 → commit → push → PR...

git worktree list   # 一覧確認
```

### 気をつけること

- **`node_modules` は worktree ごとに独立。** 作成した直後は必ず `npm ci` する。メインのチェックアウトも、`git pull` で lockfile が変わったら `npm ci` し直す (忘れると「コマンドが見つからない」系のエラーになる)
- **dev サーバのポートは自動割当 ([ADR-0030](docs/adr/0030-dev-port-autoswitch.md))。** `npm run dev` は既定ポート (editor 5173 / verify 5174 / workers 8787) が使用中だと**セットごと +10** (5183/5184/8797, …) して空きへ移り、editor の `/verify` プロキシと `VITE_API_URL` も追従する。複数 worktree・別プロジェクトとの同時起動は無調整で共存でき、実際の URL は起動バナーで確認する。個別起動 (`npm run dev:editor` 等) は従来どおり固定ポート (衝突時は vite が +1 フォールバックするだけで配線は追従しない点に注意)
- **skip-worktree はインデックス単位で、worktree 間で共有されない。** メインのチェックアウトで隠している `packages/workers/wrangler.toml` のローカル版は、新しい worktree には存在しない (HEAD のプレースホルダ版がチェックアウトされる)
- **gitignore 済みのローカル設定も worktree ごとに別。** `.dev.vars` や dev 鍵の置き場 `packages/shared/src/checkpointKeys/localKeys.ts` / `packages/shared/src/examAuthorityKeys/localKeys.ts` (#338) は新しい worktree に引き継がれない (`localKeys.ts` は `npm ci` の postinstall が `.example` の空配列版を置く)。ユニットテストはそのまま通るが、worktree 内で workers をローカル起動するには上の `wrangler.toml` と合わせて再セットアップが必要 ([packages/workers/AGENTS.md](packages/workers/AGENTS.md) の手順)。E2E は `npm run setup -w @typedcode/e2e` が鍵を実行時生成するので不要
- **`git stash` は全 worktree 共有。** 取り違えやすいので、作業を退避したいときは stash ではなく WIP コミットにする
- **同じブランチは一つの worktree にしかチェックアウトできない** (main はリポジトリ直下が使っているので、worktree で main は開けない)
- worktree の実体は `.claude/worktrees/` にあり、git 管理外 (.gitignore 済み)。消すときは `rm -rf` ではなく `git worktree remove` (または下記 sweep) を使う (git 側の登録も一緒に消えるため)

## マージ後の掃除 (git sweep)

掃除は個別の手作業ではなく `git sweep` に寄せます (方針の背景は [ADR-0029](docs/adr/0029-merge-cleanup-script.md))。仕組みは三段構え:

1. **リモートブランチ**: GitHub の「Automatically delete head branches」が有効なので、PR マージで自動削除される
2. **リモート追跡ブランチ**: `fetch.prune = true` (clone ごとに `git config fetch.prune true`) で fetch 時に自動削除される
3. **ローカルブランチと worktree**: [scripts/sweep.sh](scripts/sweep.sh) が upstream の消えた (`[gone]`) ブランチを worktree ごと削除する

セットアップ (clone ごとに一度):

```sh
git config fetch.prune true
git config alias.sweep '!bash scripts/sweep.sh'
```

運用方針: **PR をマージしたら、その流れでメインのチェックアウトから `git sweep` を実行する** (人でもエージェントでも、マージした者が実行する)。定期バッチにはせず、マージ直後の習慣として回します。

スクリプトは安全側に倒してあり、次の worktree はスキップして残します:

- 現在いる worktree
- 未コミットの変更がある worktree
- **使用中の worktree** (その中を cwd とするプロセスがいる。中で動いている Claude Code セッションやシェルなど)

スキップの理由が「自分自身」の場合——マージを終えたセッションがまだその worktree の中にいて「使用中のプロセスあり」と出る場合——セッションを閉じる必要はありません。Claude Code の `ExitWorktree` ツール (action: `keep`) でメインのチェックアウトに戻ってから `git sweep` を再実行すれば、その worktree も削除できます。`action: remove` で直接消す手もありますが、squash merge ではローカルコミットが「未マージ」と誤検知され確認を求められがちなので、`keep` で抜けて sweep に任せるほうが安全です (sweep は upstream の消滅で判定するため誤検知しない)。

スクリプトの動作検証は `npx vitest run scripts/sweep.test.ts` (使い捨てのリポジトリを組み立てる統合テスト)。CI 常設ではなく、スクリプトを変更したときに手元で回します。

### 注意: worktree を消すと、その中のセッションは再開できない

Claude Code のセッションは作業ディレクトリ単位で管理されるため、worktree を削除すると、その中で動いていたセッションは後から再開・追加依頼ができなくなります (`No conversation found with session ID` エラー)。

- **マージ後の追加依頼は、worktree の古いセッションに投げず、main から新しいセッション・新しい worktree で始める**
- 引き継ぎの真実を GitHub に置く運用 ([AGENTS.md の「Issue と着手」](AGENTS.md#issue-と着手)) を守っていれば、セッションが消えても失われる情報はない
- どうしても再開したい場合は、同じパスに worktree を作り直せば resume できる (会話ログ自体は `~/.claude/projects/` に残っている)

## Issue と着手

Issue の起票・着手してよい条件 (`verify: triaged`)・着手時の確認・作業中に踏んだ問題の行き先・コメントの置き場・ラベルは、[AGENTS.md の「Issue と着手」](AGENTS.md#issue-と着手) にまとめてあります。人にもエージェントにも同じ規律が効くので、ここには写しを置きません (写しは必ず古くなるため)。

## リリース (v* タグ)

```bash
# 1. バージョン bump PR (ルート package.json。UI の About 表示に使われる)
npm version <X.Y.Z> --no-git-tag-version --workspaces-update=false
# → PR → squash merge

# 2. main 先端の CI が green なことを確認してからタグを打つ
gh run list --branch main -L 1
gh release create vX.Y.Z --target main --title "vX.Y.Z" --generate-notes
```

- タグ push で CI (test/check/e2e) が再実行され、green 後に **production デプロイが承認待ち**になる。Actions タブで Approve すると本番反映。
- タグは main の履歴上のコミットにのみ有効 (CI が ancestor 検証で強制)。
- **タグの付け替え・削除はしない** (ruleset でも禁止)。本番が壊れたら、まず下の「[本番を戻す](#本番を戻す-ロールバック)」で直前のデプロイへ戻し、fix を入れて**次のパッチタグ**で前へ進める。
- 破壊的な証明フォーマット変更は `PROOF_FORMAT_VERSION` とも対応させる。
- 直前に CHANGELOG.md の `[Unreleased]` を `## [X.Y.Z] - <日付>` に切り、末尾の比較リンクも足す (1 の bump PR に含める)。
- **いつリリースするか** (#332): 次のどちらかに当たったら、上の手順でリリースする。リリースの見送りは、理由を Issue に残せば認める。
  - **本番に効くセキュリティ修正を main に入れたら、7 日以内**に下の「本番緊急修正」の手順でパッチタグを打つ。本番に効くセキュリティ修正とは、`security` ラベルの Issue を閉じた PR と、Dependabot の security update のこと。PR 側の `security` ラベルは付け漏れが多いので、Issue 側のラベルで判断する
  - それ以外は、**最新タグから 7 日以内**にリリースする (#657。1 回のリリースを、壊れたときに原因を追える大きさに保つため)。超えると、次の段落の自動検知が Issue を開く
- **授業・試験の期間にリリースを止める期間は、利用者がいない今は設けない**。利用者が付く前に [#662](https://github.com/shinyaoguri/typedcode/issues/662) で決める
- **リリースの停滞は自動で検知する** (#410)。週次の `freshness.yml` が、最新の `v*` タグから **7 日を超え**、かつそのタグ以降に `fix` / `feat` のコミット (`feat(scope)!:` も含む) が **1 件以上**あるとき、`chore: 本番リリースの停滞 (自動)` という Issue を開く (open のものがあればコメントを追記する。docs / chore / ci だけの 7 日超は検知しない。判定は毎週月曜なので、実際に開くのはタグから 8〜15 日の間)。通知を受けたら、上の手順でリリースする。見送るならその理由を Issue にコメントする。判定は `scripts/release-stall.mjs`

## 本番を戻す (ロールバック)

本番が壊れて fix を待てないときは、Cloudflare に残っている直前のデプロイへ戻す (#656)。タグも CI も通さないので数分で済む。戻すのは応急処置で、**その後に fix を入れて次のパッチタグを打ち、前へ進める**のは上の「リリース」「本番緊急修正」と同じ (タグは付け替えない)。

**戻す順序は Pages → Workers (deploy の逆順)**。まず Pages (editor / verify) だけを戻すのが基本で、それで直らず Worker 側が原因と分かったときに Worker も戻す。「新しい Worker + 1 つ前の editor / verify」は動くことが不変条件で保証されている ([packages/workers/AGENTS.md](packages/workers/AGENTS.md) の不変条件 10) が、逆の「1 つ前の Worker + 新しい editor / verify」は保証しない。Worker だけを戻すときは、そのリリースで editor / verify が Worker の新しい API や応答に依存していないかを先に確かめる (`git diff <前のタグ> <今のタグ> -- packages/workers/src`)。

以下、`<project>` は Pages のプロジェクト名 (GitHub の secret `CLOUDFLARE_PROJECT_NAME` の値)。wrangler は `npx wrangler login` で Cloudflare アカウントに入った状態で、`packages/workers` から打つ。

### production

```bash
cd packages/workers

# 1. Pages: 戻す先の production デプロイを探す (Source 列が commit。上が新しい)
npx wrangler pages deployment list --project-name <project> --environment production
#    → ダッシュボードの Workers & Pages → <project> → Deployments → All deployments で、
#      戻す先の行の ⋯ → "Rollback to this deployment" (確認ダイアログが出る)
#    API なら POST /accounts/{account_id}/pages/projects/<project>/deployments/{deployment_id}/rollback

# 2. Workers (Worker 側が原因のときだけ): 戻す先の版を探して戻す
npx wrangler versions list --config wrangler.production.toml
npx wrangler rollback <version-id> --config wrangler.production.toml --message "<戻す理由>"
npx wrangler deployments status --config wrangler.production.toml   # 現役の版を確認
```

- Pages の rollback の対象は**成功した production デプロイ**だけ。前へ戻すとき (fix のタグを待たずに戻した版から最新へ戻す) も同じ操作で新しい方を選べる
- `wrangler rollback` は `--message` を付けると確認の対話を飛ばす。版 ID を省くと 1 つ前の版になる。戻せるのは直近 100 版まで。前へ戻すときも同じコマンドで新しい版の ID を指定する
- Workers と Pages を両方まとめて出し直したいときは、前のタグの run の `deploy-production` job を再実行してもよい (`gh run rerun <run-id> --job <job-id>`。build から走り、承認も要るので数分〜)

### staging

Pages のロールバックは production デプロイにしか効かない (staging は `--branch=staging` の preview デプロイなので対象外)。staging の Pages は、前の main の run の `deploy-staging` job を再実行して出し直す。同じ commit で build して Workers → Pages の順に出し直すので、Workers も一緒に戻る。再実行は build からやり直すので、元のデプロイとバイト単位では同じにならない (`__BUILD_DATE__` が再実行の時刻になり、アセット名も変わる)。GitHub の secrets も再実行の時点の値を使う。1 回は 1 分弱で終わる (#656 の予行で実測)。

```bash
# Pages (+ Workers): 戻す先の main の run と、その deploy-staging の job ID を引いて再実行する
gh run list --workflow deploy.yml --branch main -L 5
gh run view <run-id> --json jobs --jq '.jobs[] | select(.name == "deploy-staging") | .databaseId'
gh run rerun <run-id> --job <job-id>
# 前へ戻すときは最新の run の deploy-staging を同じように再実行する

# Workers だけ: production と同じコマンドを wrangler.staging.toml で
npx wrangler versions list --config wrangler.staging.toml
npx wrangler rollback <version-id> --config wrangler.staging.toml --message "<戻す理由>"
```

### 戻るもの・戻らないもの

- **戻る**: Pages の配信物 (editor / verify のバンドル。`VITE_API_URL` などビルド時に埋め込んだ値も含む)。Worker のコードと、**版ごとに記録されている secret の組・`compatibility_date`・vars** (`npx wrangler versions view <version-id> --config ...` で secret の名前と bindings が見える)。署名鍵のローテをまたいで戻すと旧 `keyId` の鍵で署名することになる。公開鍵レジストリは append-only なので、その鍵を `revoked` にしていなければ動く
- **戻らない**: KV のデータ (`CHECKPOINT_SESSIONS`)、GitHub の secrets / Environment、Pages のカスタムドメインや設定。戻した後に `wrangler secret put` すると新しい版ができ、それが現役になる (戻した状態が上書きされる)

## 本番緊急修正 (hotfix)

専用ブランチはありません。通常フローの最短経路で回します:

```bash
git fetch origin
git worktree add .claude/worktrees/critical-bug -b fix/critical-bug origin/main
# 修正 → PR → squash merge → staging で確認
gh release create vX.Y.(Z+1) --target main --generate-notes   # 即パッチリリース
```

main が唯一のブランチなので、旧 Git Flow のような「main と develop の両方へ反映」という手当ては不要です。

## ADR を積み重ねる stacked PR

ADR を連続で積む stacked PR は、**squash すると土台の SHA が変わって後続 PR が壊れる**。この経路だけは squash せず、**flatten ブランチに cherry-pick → PR → Rebase and merge** で main へ着地する (main は PR 必須のため直 push はしない)。詳細は [ADR-0028](docs/adr/0028-tag-based-github-flow.md) / 既存運用。

## GitHub リポジトリ設定 (推奨)

Settings → General → Pull Requests:

- **Default to squash merging** を有効化 (普段の feature→main を squash 既定に)
- Rebase merging も有効のまま (stacked PR の flatten 用)
- **Automatically delete head branches** を有効化 (長命ブランチは main のみで、ruleset が削除から保護している。`git sweep` の 1 段目でもある)

Rulesets:

- `main`: 削除・force-push 禁止 + **PR 必須 + required status checks (test / check / e2e / pr-title / require-tests / require-visual-evidence)**
- `v*` タグ: 削除・更新禁止

コミットの規約は [Conventional Commits](https://www.conventionalcommits.org/) に従います。
