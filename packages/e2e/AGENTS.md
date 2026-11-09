# packages/e2e — AGENTS.md

`@typedcode/e2e` は **実物のエディタをブラウザで動かし、証明を export して verify-cli (と検証 Web) で検証する round-trip E2E**。editor の記録系・shared の検証系・CLI・verify の表示を 1 本で同時に検証する。

## 責務と境界

- **持つ**: Playwright (Chromium) でのシナリオ駆動、export ZIP の取得、verify-cli の spawn と exit code / `--result-json` (どの検査で落ちたか = `failedCheck`。stdout の文言ではなくこれを assert する) / `--analysis-json` / `--analysis-bundle` 判定、敵対的パック (偽造・改竄・合成打鍵・AI 一括投入) の負のオラクル、検証 Web (verify) に ZIP を入れて状態契約を読む Web↔CLI パリティ
- **持つ (UI)**: UI の振る舞いの検査。ただし **`data-*` 属性の状態契約** (実装が生の enum 値・状態を属性で出す) を読んで assert し、翻訳テキスト・CSS クラス・見た目には依存しない ([ADR-0034](../../docs/adr/0034-replace-manual-verification-with-automated-tests.md))。見た目は DOM / 状態 / a11y (axe) / レイアウト不変条件で機械検査する
- **持つ (証跡)**: 人が見る見た目・動きの証跡を撮る撮影 spec (`tests/shots.spec.ts`、タイトルに `@shots`)。**何も assert しない** (待ち合わせは data-* の状態契約と既存ヘルパの wait 系だけ)。通常の実行と CI のシャードからは `playwright.config.ts` の `grepInvert` で外し、`npm run shots` (`SHOTS=1`) のときだけ走る。base と head で同じ画面になるよう `ja-JP`・`Asia/Tokyo`・light・1280×800 で撮り、撮るたびに変わる要素 (時計・ハッシュ) は mask で隠す。何を撮ったかは `shots/manifest.json` (`[{file, caption}]`) が正本で、ファイル名は連番で固定する (CI の `.github/workflows/visual-evidence.yml` が base と head で撮り、before/after を `file` で対にして PR にコメントする / #393)。画像を比べて合否を出すのではないので、下の「画素比較を持たない」とは矛盾しない ([ADR-0036](../../docs/adr/0036-visual-evidence-on-prs.md))
- **持たない**: 画素比較 (スクリーンショット差分。OS 差と基準画像の運用コストで不採用 / ADR-0034)、翻訳テキストや見た目に依存した assert、ユニットテスト (各パッケージの `__tests__` が担う)、proof 生成/検証ロジック本体 (editor / shared)

## 重要な不変条件

1. **オラクルの第一は verify-cli の結論**: 「編集 → export → verify-cli が pass/fail」を軸にする。証明に関わる判定は DOM ではなくチェーン検証の exit code / analysis JSON で行う。UI の状態を見るのはその補助で、`data-*` の状態契約に限る (翻訳テキスト・見た目を読まない)
2. **負のオラクルを必ず持つ**: 改竄シナリオは verify-cli が **exit 1 で拒否する**ことを assert する (1 種でも素通りすると「壊れた検証器」を緑と誤認する)。positive control (無改竄が pass) と対で置く
3. **信頼打鍵と合成打鍵を区別**: Playwright の `keyboard.type` は CDP 経由で `isTrusted=true`。合成打鍵 (ADR-0018) は `page.evaluate(dispatchEvent)` で `isTrusted=false` を注入する
4. **CI 時間を意識**: PoSW full 検証は重い。**full (既定) は happy-path の 1 本だけ** (PoSW を含む完全検証の positive control)。他のシナリオはすべて `--mode fast` を渡す (検証対象がイベント意味論・チェーン整合性であり PoSW 再計算は不要)。新しい spec を足すときも既定で fast にすること。例外は検証 Web のキャンセル (`verify-web-ui.spec.ts`、#331) の 1 本で、「処理中」の項目を掴むために full で流す (fast は PoSW を飛ばして一瞬で終わる)。実行は `workers: 2` の 2 並列 (flake が再発したら 1 に戻す)。deploy.yml の e2e-shard job (shard ごと) は `timeout-minutes: 30`
5. **既知バグは失敗する再現を先に置く**: すぐ直さないバグは `test.fixme('#N ...')` (Issue 番号をタイトルに含める) で再現を置き、修正 PR で `fixme` を外す
6. **検証 Web の判定は verify-cli と突き合わせる**: verify Web の判定 (`data-status` / `#assurance-strip` / `#result-status-icon` の data-*) は、同じ ZIP に対する verify-cli の判定 (`runVerifyCliWithVerdicts`: proof ごとの `valid` + `--analysis-bundle` の三層保証) と一致することを assert し、値そのもの (fast なら integrity `partial` など) も併せて見る (両方が同じ向きに壊れても緑にしないため)。CLI から機械的に読めない **success / warning、verified / partial の区別は Web だけの TrustCalculator の導出**なので、パリティの対象外 (`tests/helpers/verifyWeb.ts` の `expectWebCliParity` の doc)

## 構成

```
tests/
├── helpers/app.ts        # EditorApp ページオブジェクト + ZIP/proof 読み出しヘルパ
├── helpers/verifyCli.ts  # tsx で verify-cli/src/cli.ts を直接実行 (build 待ち不要。dist は verify-cli の test:dist が担保)
├── helpers/verifyWeb.ts  # VerifyWebApp: 検証 Web を開き #file-input に ZIP/JSON を渡し、data-* の状態契約だけを読む
├── helpers/scenario.ts   # 利用シーン網羅 (scenarios/) の操作とフィクスチャ: .tcclass / テンプレート YAML、メニュー操作、問題の読み込み、マウスでのドラッグ・リサイズ、ファイルのドロップ、ノート付き export (app.ts は並行作業と衝突しないよう触らずここに置く)
├── helpers/examFixture.ts # exam の fixture (fixtures/exam/fixture.json) を読む: 監督コード・パッケージのパス・出題者鍵の keyId
├── helpers/faults.ts     # 障害注入 (#435): Workers の API を 1 つずつ 503 / abort / hang (呼び出し回数を返す)、Turnstile のスクリプトの遮断、IndexedDB の open 失敗・QuotaExceeded・request の success 後の transaction の abort (#543)、保存先の注入の解除、起動時の空き容量の試験の書き込みだけの失敗 (`failStorageProbe`。QuotaExceeded か、ディスク満杯で Chromium が返す `DataError: Failed to write blobs (IOError)` での abort。#626)、getDisplayMedia の stream の退避とトラックの ended
├── happy-path / multi-tab-export / reload-recovery / close-tab-recovery / ...
├── workers-hang-export.spec.ts  # Workers 無応答 (route で応答しない) でも class の export が上限内に ZIP を出す (#324。fetch 上限 + best-effort 予算)
├── tab-create-auth-budget.spec.ts # Turnstile の配信元と Workers を両方無応答にしても、class の新規タブがタブ作成の予算 (`TAB_CREATE_VERIFICATION_BUDGET_MS`) + 5 秒以内に打鍵を受け付け、未アンカーの proof が verify-cli (fast) で通る (#375)
├── proof-forgery / tamper-detection / ai-bulk-insert / synthetic-keystroke  (敵対的パック)
├── fault-session-start / fault-checkpoint-sign / fault-turnstile / fault-network / fault-storage  # 障害注入 (#435): session/start・checkpoint/sign の失敗 (API ごとに別ファイル。hang 待ちを含む 1 ファイルが CI で Playwright の Slow Test の閾値 5 分を超えたため / #525)、Turnstile 不達、オフラインの往復、IndexedDB の障害 (起動時の open の失敗で起動失敗のエラー画面 `boot-failure` が出る = #325。保存の QuotaExceeded で `failed` / `degraded`・その状態での export・解除後の回復とリロード後の export = #543)。transaction の abort は `fault-storage-abort` (#543)、保存先が全滅した状態からの救出ボタン (casual 2 タブ・exam の問題パネル) は `fault-storage-rescue` (#544。exam の分は fixture が無いとき CI では落とし、ローカルでは skip)
├── storage-low.spec.ts    # 空き容量の不足 (#626): 起動時の試験で書けない (QuotaExceeded と I/O の DataError の 2 形) と `storage-low` が出て「このまま続ける」で ready まで起動する・書けた起動では警告も試験用 DB も残らない・not-found 画面では試験しない・利用中の保存の QuotaExceeded で通知 (`#block-notification[data-notice]`) が 1 回だけ出る。dev サーバの試験の書き込み量は vite.editor.config.mjs が小さく縮める
├── multi-instance / history-navigation / viewport / ime-undo / idle / screen-capture-lock / reset-url  # 環境の揺さぶり (#435): 多重起動・戻る / 進む・狭い画面・IME と undo / redo・アイドル停止・画面共有の停止・`?reset` が何も消さないこと (#323) とリセットの現在のモード限定
├── code-execution.spec.ts # JS / TS の実行の隔離と停止 (#290 / ADR-0041): 停止後に出力・副作用が出ない・同期ループ中も記録が進む (テスト側の watchdog)・親 DOM / IndexedDB / localStorage / ネットワーク / `/author` の `#author-jwk` に届かない・停止 → 即再実行・outcome の区別とエラーのマーカーの行・出力予算・異常の後の export と verify-cli (fast)。実行の状態は `data-exec-*`、上限は dev 限定の `window.__tcExecLimits` で縮める
├── code-execution-c-python.spec.ts # @nightly: C (Wasmer + clang) と Python (Pyodide) の実行のスモーク (#589): hello の出力・proof の result イベント (success)・export が verify-cli (fast) を通る、C のコンパイルエラーの行番号とマーカーが利用者のコードの行を指す (#489 の回帰)、Python の `input()` がターミナルに打った行を読み `window.prompt` を呼ばない・案内文が入力の前に出る・入力待ちの停止が aborted で次の実行ができる (#649)。clang の webc (約 100 MB) と Pyodide を外部から取るので PR ゲートには載せない
├── state-contract.spec.ts # editor の状態契約: タブ操作の各段階で DOM の data-* と __tcTestSnapshot が一致する (#433)。export のダウンロードの瞬間 (自己検証より前) にも件数とハッシュが揃っている (#521)
├── export-during-verify.spec.ts # 1 回目の export のダウンロード直後 (自己検証の終わる前) に押した 2 回目の export も ZIP を出し、verify-cli (fast) で pass する (#565)。ダウンロードの瞬間に何かを読む・押すときは、`a[download]` の追加を MutationObserver で捕まえる (この 2 本が例)
├── fault-exam-signing-token.spec.ts # exam の開始時に session/start が応答しない (#236): ゲートの人間確認 (`#exam-gate-attestation[data-attestation-state]`) が `pending` のまま解錠でき、#0 は合成の印 (`verified:false`)、token の無い間も export は止まらず checkpoint は未署名。塞ぎを外して `online` を起こすと署名 token を取り直し、以降の checkpoint が署名されて verify-cli --exam-package (fast) が通る。fixture が無いとき CI では落とし、ローカルでは skip
├── exam-roundtrip.spec.ts # exam モードの round-trip (#229): 誤コードの拒否 → ゲートの人間確認が `verified` になってから正コードで解錠 (#0 が `verified:true` で token 由来の印を持つ = #236) → 打鍵 → export → verify-cli --exam-package (束縛 PASS) と負のオラクル → 同じ ZIP を verify Web に入れ、`#exam-load-btn` から同じ `.tcexam` を渡すと `#assurance-strip[data-temporal]` が `exam-t0` になり、verify-cli の `--analysis-bundle` と一致する (渡す前は exam-t0 でないことも見る。束縛の内訳は Web に契約が無いので見ない)。fixture が無いとき CI では落とし、ローカルでは skip
├── scenarios/*.spec.ts   # editor の利用シーン網羅 (#434): 入口 (`entry.spec.ts`: `/` の規約通知・直リンクの最初の画面・モード表示。#644)・規約・class/assignment・復旧の新規開始・タブ並べ替え・8 言語・テーマ/表示言語・リセット・テンプレート・パネル・問題の入出力例 (`problem-examples.spec.ts`: 表示・タブ切替・リロード・コピーが proof に記録されない。#648)・セルフレビュー・メインメニュー。各シナリオは expectConsistent() と verify-cli (fast) で締める。既知の製品バグは test.fixme('#N ...') で再現を置く
├── verify-web-parity / verify-web-submission / verify-web-ui  # 検証 Web の往復 (3 ファイルに分割: 1 ファイル 10 本が CI で Playwright の Slow Test の閾値 5 分を超えたため / #533)。parity = Web↔CLI パリティ・改ざん・version gate。submission = 複数ファイルの混在 (#215)・壊れた proof (#292)・同梱ソースの差し替え (#293)。ui = タブを閉じたあとの active / 表示の一致 (#281 / #387)・チャートタブ (#395)。共通の手順 (`typeAndExport` / `expectWebCliParity` / `proofNames`) は `helpers/verifyWeb.ts`
├── model/                # model-based E2E (#436): fast-check の fc.commands でランダムな操作列を流し、各手の後にモデル (editorModel.ts) と状態契約・snapshot・件数・エラーを突き合わせ、最後に全タブの export を verify-cli (fast) で検証する。手には、ブラウザのタブを閉じて復旧ダイアログから再開する `CloseAndResume` (IndexedDB からの復旧経路。`Reload` は sessionStorage 経路。#450) を含む。PR ゲートは固定シード 2 本 × 15 手 (手を足したら dry-run でシードを選び直す。根拠は model-based.spec.ts のコメント)、`@nightly` はランダムシードの長尺。実アプリの操作は playwrightDriver.ts、実行と失敗の報告 (シード・縮約後の操作列・再実行コマンド) は runner.ts
├── shots.spec.ts         # @shots: 証跡の撮影だけ (assert なし・通常実行から除外)。撮影 spec を増やすなら *.shots.spec.ts (require-tests がテストに数えない命名) にし、タイトルに @shots を付ける
├── posw.bench.spec.ts    # @bench: 記録側 PoSW のスループットと backlog を 1 倍と CPU 4 倍相当で測る (assert なし・通常実行と CI から除外。`npm run bench:posw` = BENCH=1)。CDP の CPU スロットルは dedicated Worker に効かないので、PoSW の Worker は route で差し込む busy-wait で処理時間を引き延ばす (ADR-0045 / #241)
├── deployed.spec.ts      # デプロイ済みの staging 専用 (#655。既定・build の config からは外す): `/casual` で打鍵 → export → verify-cli (fast) が pass、console / pageerror 0 件、署名付き checkpoint と sessionStartToken の keyId がすべて staging の鍵 (spec の定数。registry.ts に active で載っていることも見る)、temporal が `anchored`、同じ ZIP を配信物の `/verify/` に入れて verify-cli と状態契約が一致する。dev フックに依存しない
└── production-build.spec.ts  # dist 専用スモーク (editor + /verify/。既定 config からは testIgnore で除外)。`@nightly` の C の hello (@wasmer/sdk の worker は本番ビルドでしか壊れない = #364) は PR ゲートの test:build から外し、毎晩だけ回す (#589)
playwright.config.ts       # dev 用: webServer で workers(:8787) + editor vite dev(:5173) + verify vite dev(:5174)
ports.ts                   # 上の 3 ポート (E2E_*_PORT で上書き)。playwright.config.ts と global-setup.ts が読む (build 設定も workers の値を読む)
global-setup.ts            # テストより前に、起こした / 再利用した 3 台がこの作業ツリーのサーバかを照合し、違えば throw (#552。下記の罠)。照合部は checkIdentities として export
global-setup.build.ts      # build 設定用: workers 1 台だけを checkIdentities で照合する (再実行例は test:build。#560)
scripts/server-identity.mjs # 上の照合の判定 (純関数) と問い合わせ。テストは server-identity.test.mjs (node --test)
playwright.build.config.ts # dist 用: workers + editor/verify を build し、verify を editor の dist の verify/ に重ねて vite preview(:4173)
playwright.deployed.config.ts # デプロイ済みの配信物用 (#655): サーバを起こさず globalSetup も持たない。baseURL は必須の E2E_DEPLOYED_URL (無ければ throw)。deployed.spec.ts だけを走らせる
scripts/setup-env.mjs      # CI 用: 無い localKeys.ts を .example から作る (#338) + Turnstile 公開テストキー配置 + checkpoint 署名鍵を実行時生成
scripts/setup-exam-fixture.mjs # exam 用 fixture: 使い捨ての出題者鍵を作り make-exam-package.mjs で p1 / other の .tcexam を packages/e2e/fixtures/exam/ (gitignore 済み) に生成。`npm run setup` が setup-env.mjs の次に走る。揃っていれば何もしない
exam-keys/ + vite.editor.config.mjs + vite.verify.config.mjs # exam の出題者鍵の差し替え (下記の罠): editor / verify の dev サーバ用 Vite プラグインと、verify-cli (tsx) 用の resolve フック
scripts/stage-verify-dist.mjs # dist 用: deploy.yml の「Merge build outputs」と同じ配置 (editor/dist/verify) を作る
shots/                     # npm run shots の出力 (PNG・アニメーション WebP・manifest.json)。gitignore 済み
```

## 実行

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
```

**`@nightly` は通常の実行と CI のシャードから外れる** (`playwright.config.ts` と `playwright.build.config.ts` の grepInvert。`@shots` と同じ扱いで、`NIGHTLY=1` のときだけ含める)。毎晩 `.github/workflows/e2e-nightly.yml` が `--grep @nightly --retries=0` で dev 設定 (`test`) と本番ビルド (`test:build`。出力先は `test-results-build/` に分ける) の順に回し、失敗したらテストの出力ディレクトリの `model-failure.md` (シード・縮約後の操作列・再実行コマンド) を同名の open Issue に集める。model-based の失敗は報告に出る `FC_SEED=… FC_PATH=… FC_REPLAY_PATH=…` を付けて同じ列を再実行できる。fast-check の縮約は同じ列を何度も流し直すので、**列ごとに新しいブラウザコンテキストで始める** (同じページで `openCasualFresh()` を繰り返すと前の列の状態が残る)。

**`pretest` / `preshots` は `npm run setup && npm run install-browsers`**。`.env` も `.dev.vars` もブラウザも無い新しい worktree・環境で、`npm ci` の直後に `npm run test` だけで通る。どちらも繰り返し実行して安全: setup は既存の `.dev.vars` を上書きせず鍵 ID の検査だけ、`playwright install` は導入済みなら何もしない。`test:headed` / `test:ui` / `test:build` には付けていない (準備済みの環境で使う前提)。`--with-deps` は sudo が要るので付けておらず、Linux で共有ライブラリが足りなければ手で `npx playwright install --with-deps chromium` を打つ (CI は deploy.yml の既存 step が入れる)。

CI では `deploy.yml` の `e2e-shard` job が Playwright の `--shard=1/2` / `2/2` を matrix で並列に走らせ (`test:build` は shard 1 だけ)、集約 job **`e2e`** が全 shard の成功を要求する。`e2e` が main ruleset の required check であり、`build-preview` (PR プレビューの build。deploy は `deploy-preview.yml` が成功した run の artifact でだけ行う) / `deploy-staging` / `deploy-production` の **必須ゲート** (`needs: [test, check, e2e]`) になっている。matrix の job は check 名が `e2e (shard 1/2)` に変わるので、**集約 job の名前 `e2e` と `if: always()` を外さないこと** (外すと shard 失敗時に skipped = ruleset 上は通過になる)。shard の手元再現は `npm run test -w @typedcode/e2e -- --shard=1/2`

**`test:deployed` は staging にだけ当てる (#655 / ADR-0049)**。CI では `deploy.yml` の `e2e-staging` job が、main push の `deploy-staging` の後に、その deploy の Pages の URL (wrangler-action の `deployment-url` = `https://<label>.typedcode.pages.dev`。deploy ごとに固定で、後の push で `staging.` の alias が動いても相手がずれない) を `E2E_DEPLOYED_URL` に渡して走らせる。job 間では `<label>` だけを渡す (プロジェクト名が secret に入っていて、URL のままでは GitHub が secret を含む job output として空にする)。staging は Turnstile の公開テストキーで動くので headless で通る。production の deploy には付けない (本物の Turnstile は headless で安定して通らず、通すための緩めを production に入れない)。spec は staging の署名鍵を期待するので、production に向けても通らない。`npm run setup` は要らない (相手は手元の workers ではなく、verify-cli が import する `localKeys.ts` は `npm ci` の postinstall が `.example` から作る)

### モード共通の入口 (helpers/app.ts)

- `openModeFresh(mode, { acceptTerms, screenShare, waitReady })`: `/<mode>` を新しい context で開く (保存データを消す仕組みは無い。独立は Playwright の context 分離が担う)。利用規約は init script で localStorage `typedcode-terms-accepted` を入れて飛ばす (既定は casual 以外)。起動時の画面共有の選択ダイアログ (`.screen-share-choice-dialog`。class と exam で出ることを確認済み) は `screenShare: 'share' | 'optOut'` で選ぶ (`optOut` は続けて出る確認ダイアログ `.screen-share-optout-confirm-dialog` の confirm まで閉じる。#374)。問題の読み込み・試験ゲートは各モードの spec 側で足す
- **editor の UI 状態は状態契約と `expectConsistent()` で判定する** (#433): タブ・カウンタ・同期・アプリの段階・ダイアログは [packages/editor/AGENTS.md の「状態契約」](../editor/AGENTS.md) の data-* と dev フック `__tcTestSnapshot` だけを読む (`tabs()` / `openDialogs()` / `snapshot()` / `appState()`)。操作の後は `expectConsistent()` で DOM と内部状態の一致を確かめる (アクティブなタブの PoSW pending が 0 になって DOM が追いつくまで待ち、揃わなければ食い違いの一覧を添えて落ちる)。`__tcTestSnapshot` は dev 限定なので `production-build.spec.ts` からは使わない。タブ操作は `addTab` / `switchToTab` / `renameTab` / `requestCloseTab` + `answerCloseTab` / `setLanguage` を使う。通しの例は `tests/state-contract.spec.ts`
- export は `exportCurrentTab` / `exportAllTabs` (ダウンロードメニュー) と `exportViaLogButton` (問題パネルの `#download-log-btn`。exam はこちらに一本化される)
- `writeZipVariant` / `tamperFirstContentChange`: export ZIP を書き換えた ZIP (改ざん・proof の改名・壊れたエントリの追加) を作る。verify Web には ZIP のまま渡す

## よくある罠

- **別の作業ツリーのサーバは再利用しない (#552)**: `reuseExistingServer` (ローカルのみ) は `port:` の TCP 応答しか見ないので、並行する worktree の本物の editor / workers / verify が同じポートを握っていると、黙ってそこにつながる。向こうの worktree の `.dev.vars` の鍵で署名された証明を、こちらの `localKeys.ts` で検証して `Unknown keyId: tcp-e2e-…` で落ちるなど、原因から離れた所で失敗する。そのため各 dev サーバは作業ツリーの識別子 (`scripts/worktree-id.mjs`。sha256(realpath(リポジトリのルート)) の先頭 12 桁) を名乗り (editor / verify は `vite.config.ts` の `server.headers` の `X-TypedCode-Worktree`、workers は packages/workers の `dev` スクリプトが渡す `--var DEV_WORKTREE_ID` を `/health` の `worktree` で返す)、`global-setup.ts` がテストより前に 3 台を照合する。別の識別子・識別子なし (照合が入る前の版で動く worktree か、TypedCode 以外のプロセス)・応答なしのどれかなら、テストを 1 本も走らせずに「ポート N は別の作業ツリーのサーバが使用中 (相手: <パス>)」の形で throw する (相手のパスは `git worktree list` の各パスを同じ式でハッシュして引く)。止めるか `E2E_*_PORT` で空きポートを指定する。照合は CI でも走る (CI は毎回この checkout からサーバを起こすので必ず一致し、名乗りの配線が壊れたら CI で気付ける)。build 設定 (`playwright.build.config.ts` / `test:build`) も workers 1 台を `global-setup.build.ts` で照合する (#560。editor-preview は `reuseExistingServer: false` で毎回この作業ツリーの dist から起こすので照合しない)。build 設定の workers も `--port` を渡し、editor-preview に `WORKERS_PORT` を渡すので、`E2E_WORKERS_PORT` を変えれば workers もビルドした editor の `VITE_API_URL` もそのポートに揃う
- **exam の出題者鍵は開発者の鍵置き場に書かない (#229, #338)**: `packages/shared/src/examAuthorityKeys/localKeys.ts` は verifier の信頼の根で、開発者が自分の dev 鍵を置く場所 (gitignore 済み。無ければ `.example` から作られる)。E2E の使い捨て鍵を書くと開発者の鍵を壊し、e2e の後も手元の通常の dev サーバ・verifier が偽の出題者鍵を信頼し続ける。そのため fixture 生成はこのファイルを触らず、`./localKeys` の import を E2E の実行時だけ差し替える (editor と verify の dev サーバは `playwright.config.ts` の webServer が `--config ../e2e/vite.editor.config.mjs` / `vite.verify.config.mjs` で起こす。verify Web は `.tcexam` の署名をこの registry で検証するので、差し替えないと束縛が検証済みにならず `exam-t0` にならない。verify-cli は `runVerifyCli(..., { examAuthorityKeys: true })` が `exam-keys/node-register.mjs` を tsx の `--import` に付ける)。`--exam-package` に E2E の fixture を渡すときだけ `examAuthorityKeys: true` にし、他の検証は本物の registry のままにする。差し替え先 (`fixtures/exam/authority-keys.mjs`) が無ければどちらも何もしない。spec は `localKeys.ts` に fixture の keyId が混ざっていないことも assert する。**同じ作業ツリーの通常の dev サーバ (`npm run dev`) が同じポートを握っていると、下の照合は通るが差し替えが効かず「出題者の署名を検証できない」で落ちる**ので、`E2E_EDITOR_PORT` 等で空きポートを指定する (別の worktree のサーバなら照合が先に落とす)。注: `setup-env.mjs` は `.dev.vars` の無い環境で checkpoint 鍵の `localKeys.ts` に E2E の公開鍵を書く (その環境には開発者の鍵が無い前提。gitignore 済みなので `git status` には出ない)
- **exam の解錠は Argon2id がメインスレッドで同期に走る**: 押した直後の数秒ページが固まる (本番パラメータのまま。署名検証 + 復号で数秒、遅い CI ランナーを見込んで `unlockExam` は 120 秒待つ)。誤コードのエラー表示 (`#exam-gate-error` の `hidden` 属性) と `html[data-app-state]` (`gate` → `ready`) で待ち、翻訳テキストは読まない。誤コードと「署名が信頼できない」は文言でしか区別できないので、同じ test の中で誤コード → 正コードの順に流し、正コードで解錠できることを「署名検証は通っている」の証拠にしている
- **`verify-cli` は tsx で src を直接実行**: build を待たずに済むよう `helpers/verifyCli.ts` が `tsx cli.ts` で src を直接実行する。配布物 `dist/cli.js` (esbuild の単一 ESM bundle, #298) が素の node で動くことは verify-cli の `npm run test:dist` が CI で担保する
- **待ちの既定は 30 秒で、`waitFor` 系にも効く (#584)**: 両 config の `actionTimeout` / `navigationTimeout` は 30 秒。`actionTimeout` は context の既定 timeout になるので (手で作る `browser.newContext()` も同じ)、click などの操作だけでなく、timeout を渡していない `page.waitForFunction` / `waitForEvent` (`download` / `popup` / `filechooser` / `load`) / `locator.waitFor` もこの値で切れる。30 秒を超えて待つ箇所は、その呼び出しに timeout を渡す (起動待ちは `helpers/app.ts` の `BOOT_TIMEOUT_MS`)。`expect` / `expect.poll` は `expect.timeout` (15 秒) が決め、`page.evaluate` と `keyboard.type` は上限を持たない
- **class のリロードに `reloadAndResume()` は使えない**: class は起動のたびに画面共有の選択が出るので、`eventCount` 待ちで止まる。`waitForSynced` → `reload` → 画面共有の選択に答える → `waitResumed` の順に spec の中で行う (例: `scenarios/problem-examples.spec.ts`)。クリップボードは playwright.config.ts で読み書きの権限が付いているので、`navigator.clipboard.readText()` で中身を確かめられる
- **打鍵直後の即リロードはイベント取り残し**: PoSW / IndexedDB flush 前に reload するとチェーンが途切れる。`waitForSynced` (`#sync-status-item[data-state="synced"]` + `#event-count[data-count]` の安定) を挟む。event-count が 30 秒以内に安定しなければ throw する (#229。以前は黙って return し、原因から離れた所で落ちていた)
- **URL を開くだけで保存データは消えない (#323)**: `?reset` の全消去は撤去済み (`?reset` も `?reset=1` も何も消さない)。テストの独立は Playwright の context 分離に頼る。同じ context で `openCasualFresh()` を繰り返しても前のセッションは残る (復旧ダイアログ・復元が出る)。init script で入れた localStorage の値 (`installTermsAccepted`) もそのまま残る。消去を検査するのは設定メニューのリセット (`scenarios/reset.spec.ts`。現在のモードの DB とキーだけが消える)
- **verify Web の判定は「選んだファイル」のもの**: `#assurance-strip` / `#result-status-icon` は表示中のタブ 1 つ分しか持たない。`VerifyWebApp.readVerdict` はサイドバーの行を選んでから読む。同じ export から作った ZIP を 2 つ入れると表示名 (`data-filename`) が重なって行が定まらないので、`writeZipVariant({ renameProof })` で proof 名を変える。`data-status` が `success` のプレーンテキスト (README・ソース) に判定は付かないので、読むのは `*_proof.json` だけ
- **verify Web の完了待ちはサイドバーの全行で見る**: `#vp-step-*` は表示中のタブの進捗表示 (状態契約の外) なので待ちに使わない。`waitSettled` は全 `.file-item` の `data-status` が pending / verifying でなく、それが 2 回続けて同じになるまで待つ
- **`vite preview` は `server.proxy` を引き継ぐ**: editor の `preview.proxy: {}` を外すと `/verify` が dev の verify サーバへ転送され、本番ビルドのスモークで 502 になる
- **headless では本物の window blur が出ない**: `window.dispatchEvent(new Event('blur'))` で発火させる (handleBlur は isTrusted 非依存)
- **画面共有は fake-media フラグで動く**: `playwright.config.ts` の chromium 引数で `getDisplayMedia` が monitor の fake stream を返す
- **画面共有の停止は `track.stop()` では再現できない**: ページ自身が止めたトラックには `ended` が発火しない。`faults.ts` の `captureDisplayStreams` で stream を退避し、`endLastScreenShare` でトラックに `ended` を直接投げる
- **API の障害は 1 つずつ塞ぐ**: `**/api/**` をまとめて塞ぐと casual の export 前認証 (`/api/verify-captcha`) まで落ち、export が設計どおり中止される。`injectApiFault` でエンドポイントを選び、返る `calls()` で注入が空振りしていないことを assert する。hang は 1 回あたり fetch 上限 (10 秒) かかるので、`addTab` (expect の既定 15 秒) では足りないことがある
- **`setOffline` は読込後にだけ使う**: 読込前に入れると Monaco などの読み込みまで遮断される。読込後の数秒の往復では Vite の HMR がページを読み直さないことを実測した (`fault-network.spec.ts` が navigation の回数で見張る)
- **打鍵した改行は `\r\n` になる**: `devices['Desktop Chrome']` は Windows の UA なので Monaco のモデルの改行が CRLF になり、`keyboard.type('a\n')` の内容は `a\r\n`。最終内容を文字列で比べる spec は改行を打たないか、改行を正規化して比べる
- **undo / redo は Ctrl 系で押す**: `devices['Desktop Chrome']` は Windows の UA なので、Monaco は mac の上でも Ctrl+Z / Ctrl+Shift+Z を undo / redo にする (`ControlOrMeta` だと mac では Cmd になって何も起きない)
- **`page.clock` の時刻表記は `hh:mm:ss`**: `'60:00'` は不正 (分は 59 まで)。1 時間は `'01:00:00'`。setInterval のカウントダウンは `fastForward` (各タイマー高々 1 回) ではなく `runFor` で回す
- **AI 一括投入の再現は dev フック経由**: `keyboard.insertText` は Monaco が 1 文字ずつ分解するため再現にならない。`window.__tcTestInsertBlock` (dev 限定) で `executeEdits` を 1 回適用する
- **dev サーバ向けの spec は本番ビルドの退行を検出できない (#255)**: チャンク分割・バンドル変換の壊れ方は `vite build` の出力にしか現れない。`production-build.spec.ts` + `playwright.build.config.ts` がその 1 本の番人で、`vite preview` に対して走る。dev フック (`__tcTestInsertBlock` / `__tcTestSnapshot`) は dist に無い (無いことを同 spec が assert する) ので、この経路の spec は増やすなら **dev 限定 API に依存しない**こと
