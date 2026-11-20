# packages/e2e — 実行 (コマンド・nightly・CI のシャード・staging・helper の入口)

E2E の回し方の全部と、`helpers/app.ts` の入口。[AGENTS.md](../AGENTS.md) から移した節。

```bash
npm run test -w @typedcode/e2e               # 全シナリオ (サーバは Playwright が自動起動)。pretest が setup と install-browsers を先に走らせる (#335)
npm run test:build -w @typedcode/e2e         # 本番ビルドのスモークのみ (build → vite preview)
E2E_DEPLOYED_URL=https://staging.typedcode.pages.dev npm run test:deployed -w @typedcode/e2e   # デプロイ済みの staging の round-trip (#655)
npm run test:headed -w @typedcode/e2e        # 失敗調査 (ブラウザ表示)
npm run shots -w @typedcode/e2e              # 見た目・動きの証跡を shots/ に撮る (@shots だけ。WebP の束ねに img2webp が要る。preshots が同じ準備をする)
npm run setup -w @typedcode/e2e              # 単独で打つとき: テストキー + 署名鍵 + exam fixture の用意 (pretest / preshots が呼ぶ)
npm run install-browsers -w @typedcode/e2e   # 単独で打つとき: Chromium の導入 (同上。OS の共有ライブラリは入れない)
NIGHTLY=1 npm run test -w @typedcode/e2e -- --grep @nightly   # 毎晩の長い E2E だけ (model-based の長尺。FC_SEED / FC_RUNS / FC_STEPS で上書き) と C / Python の実行のスモーク
NIGHTLY=1 npm run test:build -w @typedcode/e2e -- --grep @nightly   # 本番ビルドの @nightly だけ (C の hello。@wasmer/sdk を上げる PR では手元でも回す)
npm run bench:posw -w @typedcode/e2e         # 記録側 PoSW のベンチ (@bench だけ。packages/e2e/bench/ に JSON。BENCH_ITERATIONS で反復数の見積もり。ADR-0045)
npm run bench:export -w @typedcode/e2e       # export の容量のベンチ (`export-capacity.bench.spec.ts` だけ。`-- --grep "padded"` / `"real typing"` で絞る。重いので 1 本ずつ)
```

**`@nightly` は通常の実行と CI のシャードから外れる** (`playwright.config.ts` と `playwright.build.config.ts` の grepInvert。`@shots` と同じ扱いで、`NIGHTLY=1` のときだけ含める)。毎晩 `.github/workflows/e2e-nightly.yml` が `--grep @nightly --retries=0` で dev 設定 (`test`) と本番ビルド (`test:build`。出力先は `test-results-build/` に分ける) の順に回し、失敗したらテストの出力ディレクトリの `model-failure.md` (シード・縮約後の操作列・再実行コマンド) を同名の open Issue に集める。PR ゲートの shard (`retries: 1`) で retry で通った flaky も同じ形で集める (#583): CI のときだけ両 config が `reports/e2e.json` / `reports/e2e-build.json` に Playwright の json レポートを出し、`scripts/e2e-flaky.mjs` (ルートの scripts/) が job summary に一覧を出し、main への push の run でだけ deploy.yml の `e2e-flaky-report` が `test: E2E の flaky (自動)` の Issue に run の URL・テスト名・1 回目のエラーの先頭を追記する。model-based の失敗は報告に出る `FC_SEED=… FC_PATH=… FC_REPLAY_PATH=…` を付けて同じ列を再実行できる。fast-check の縮約は同じ列を何度も流し直すので、**列ごとに新しいブラウザコンテキストで始める** (同じページで `openCasualFresh()` を繰り返すと前の列の状態が残る)。

**`pretest` / `preshots` は `npm run setup && npm run install-browsers`**。`.env` も `.dev.vars` もブラウザも無い新しい worktree・環境で、`npm ci` の直後に `npm run test` だけで通る。どちらも繰り返し実行して安全: setup は既存の `.dev.vars` を上書きせず鍵 ID の検査だけ、`playwright install` は導入済みなら何もしない。`test:headed` / `test:ui` / `test:build` には付けていない (準備済みの環境で使う前提)。`--with-deps` は sudo が要るので付けておらず、Linux で共有ライブラリが足りなければ手で `npx playwright install --with-deps chromium` を打つ (CI は deploy.yml の既存 step が入れる)。

CI では `deploy.yml` の `e2e-shard` job が Playwright の `--shard` で 3 分割して matrix で並列に走らせ (分割数の正本は matrix の `shard: [1, 2, 3]`。分母は `strategy.job-total` から取るので、変えるのはそこだけ。#772) (`test:build` は shard 1 だけ)、集約 job **`e2e`** が全 shard の成功を要求する。`e2e` が main ruleset の required check であり、`build-preview` (PR プレビューの build。deploy は `deploy-preview.yml` が成功した run の artifact でだけ行う) / `deploy-staging` / `deploy-production` の **必須ゲート** (`needs: [test, check, e2e]`) になっている。matrix の job は check 名が `e2e (shard 1/3)` に変わるので、**集約 job の名前 `e2e` と `if: always()` を外さないこと** (外すと shard 失敗時に skipped = ruleset 上は通過になる)。shard の手元再現は `npm run test -w @typedcode/e2e -- --shard=1/3`

**`test:deployed` は staging にだけ当てる (#655 / ADR-0049)**。CI では `deploy.yml` の `e2e-staging` job が、main push の `deploy-staging` の後に、その deploy の Pages の URL (wrangler-action の `deployment-url` = `https://<label>.typedcode.pages.dev`。deploy ごとに固定で、後の push で `staging.` の alias が動いても相手がずれない) を `E2E_DEPLOYED_URL` に渡して走らせる。job 間では `<label>` だけを渡す (プロジェクト名が secret に入っていて、URL のままでは GitHub が secret を含む job output として空にする)。staging は Turnstile の公開テストキーで動くので headless で通る。production の deploy には付けない (本物の Turnstile は headless で安定して通らず、通すための緩めを production に入れない)。spec は staging の署名鍵を期待するので、production に向けても通らない。`npm run setup` は要らない (相手は手元の workers ではなく、verify-cli が import する `localKeys.ts` は `npm ci` の postinstall が `.example` から作る)

## モード共通の入口 (helpers/app.ts)

- `openModeFresh(mode, { acceptTerms, screenShare, waitReady })`: `/<mode>` を新しい context で開く (保存データを消す仕組みは無い。独立は Playwright の context 分離が担う)。利用規約は init script で localStorage `typedcode-terms-accepted` を入れて飛ばす (既定は casual 以外)。起動時の画面共有の選択ダイアログ (`.screen-share-choice-dialog`。class と exam で出ることを確認済み) は `screenShare: 'share' | 'optOut'` で選ぶ (`optOut` は続けて出る確認ダイアログ `.screen-share-optout-confirm-dialog` の confirm まで閉じる。#374)。問題の読み込み・試験ゲートは各モードの spec 側で足す
- **editor の UI 状態は状態契約と `expectConsistent()` で判定する** (#433): タブ・カウンタ・同期・アプリの段階・ダイアログは [packages/editor/AGENTS.md の「状態契約」](../../editor/AGENTS.md) の data-* と dev フック `__tcTestSnapshot` だけを読む (`tabs()` / `openDialogs()` / `snapshot()` / `appState()`)。操作の後は `expectConsistent()` で DOM と内部状態の一致を確かめる (アクティブなタブの PoSW pending が 0 になって DOM が追いつくまで待ち、揃わなければ食い違いの一覧を添えて落ちる。タブに見える名前 = `.tab-filename` + `.tab-extension` が `data-filename` と同じことも見る。改名の編集中のタブは除く。#828)。タブに見える名前そのものは `visibleTabNames()` で読む (回帰は `scenarios/tab-visible-name.spec.ts`)。`__tcTestSnapshot` は dev 限定なので `production-build.spec.ts` からは使わない。タブ操作は `addTab` / `switchToTab` / `renameTab` / `requestCloseTab` + `answerCloseTab` / `setLanguage` を使う。通しの例は `tests/state-contract.spec.ts`
- export は `exportAllTabs` (左のダウンロードボタン `#download-btn`) と `exportViaLogButton` (問題パネルの `#download-log-btn`。exam はこちらに一本化される)。どちらも全タブの ZIP で (#779)、タブ 1 つなら `<name>_TC<ts>.zip`、2 つ以上なら `ALL_TC<ts>.zip`。セルフレビューにノートを書いて出すのは `helpers/scenario.ts` の `exportWithNote`
- `writeZipVariant` / `tamperFirstContentChange`: export ZIP を書き換えた ZIP (改ざん・proof の改名・壊れたエントリの追加) を作る。verify Web には ZIP のまま渡す
