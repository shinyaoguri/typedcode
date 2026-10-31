# packages/e2e — AGENTS.md

`@typedcode/e2e` は **実物のエディタをブラウザで動かし、証明を export して verify-cli (と検証 Web) で検証する round-trip E2E**。editor の記録系・shared の検証系・CLI・verify の表示を 1 本で同時に検証する。

## 責務と境界

- **持つ**: Playwright (Chromium) でのシナリオ駆動、export ZIP の取得、verify-cli の spawn と exit code / `--analysis-json` / `--analysis-bundle` 判定、敵対的パック (偽造・改竄・合成打鍵・AI 一括投入) の負のオラクル、検証 Web (verify) に ZIP を入れて状態契約を読む Web↔CLI パリティ
- **持つ (UI)**: UI の振る舞いの検査。ただし **`data-*` 属性の状態契約** (実装が生の enum 値・状態を属性で出す) を読んで assert し、翻訳テキスト・CSS クラス・見た目には依存しない ([ADR-0034](../../docs/adr/0034-replace-manual-verification-with-automated-tests.md))。見た目は DOM / 状態 / a11y (axe) / レイアウト不変条件で機械検査する
- **持たない**: 画素比較 (スクリーンショット差分。OS 差と基準画像の運用コストで不採用 / ADR-0034)、翻訳テキストや見た目に依存した assert、ユニットテスト (各パッケージの `__tests__` が担う)、proof 生成/検証ロジック本体 (editor / shared)

## 重要な不変条件

1. **オラクルの第一は verify-cli の結論**: 「編集 → export → verify-cli が pass/fail」を軸にする。証明に関わる判定は DOM ではなくチェーン検証の exit code / analysis JSON で行う。UI の状態を見るのはその補助で、`data-*` の状態契約に限る (翻訳テキスト・見た目を読まない)
2. **負のオラクルを必ず持つ**: 改竄シナリオは verify-cli が **exit 1 で拒否する**ことを assert する (1 種でも素通りすると「壊れた検証器」を緑と誤認する)。positive control (無改竄が pass) と対で置く
3. **信頼打鍵と合成打鍵を区別**: Playwright の `keyboard.type` は CDP 経由で `isTrusted=true`。合成打鍵 (ADR-0018) は `page.evaluate(dispatchEvent)` で `isTrusted=false` を注入する
4. **CI 時間を意識**: PoSW full 検証は重い。**full (既定) は happy-path の 1 本だけ** (PoSW を含む完全検証の positive control)。他のシナリオはすべて `--mode fast` を渡す (検証対象がイベント意味論・チェーン整合性であり PoSW 再計算は不要)。新しい spec を足すときも既定で fast にすること。実行は `workers: 2` の 2 並列 (flake が再発したら 1 に戻す)。deploy.yml の e2e-shard job (shard ごと) は `timeout-minutes: 30`
5. **既知バグは失敗する再現を先に置く**: すぐ直さないバグは `test.fixme('#N ...')` (Issue 番号をタイトルに含める) で再現を置き、修正 PR で `fixme` を外す
6. **検証 Web の判定は verify-cli と突き合わせる**: verify Web の判定 (`data-status` / `#assurance-strip` / `#result-status-icon` の data-*) は、同じ ZIP に対する verify-cli の判定 (`runVerifyCliWithVerdicts`: proof ごとの `valid` + `--analysis-bundle` の三層保証) と一致することを assert し、値そのもの (fast なら integrity `partial` など) も併せて見る (両方が同じ向きに壊れても緑にしないため)。CLI から機械的に読めない **success / warning、verified / partial の区別は Web だけの TrustCalculator の導出**なので、パリティの対象外 (verify-web.spec.ts の `expectWebCliParity` の doc)

## 構成

```
tests/
├── helpers/app.ts        # EditorApp ページオブジェクト + ZIP/proof 読み出しヘルパ
├── helpers/verifyCli.ts  # tsx で verify-cli/src/cli.ts を直接実行 (build 待ち不要。dist は verify-cli の test:dist が担保)
├── helpers/verifyWeb.ts  # VerifyWebApp: 検証 Web を開き #file-input に ZIP/JSON を渡し、data-* の状態契約だけを読む
├── happy-path / multi-tab-export / reload-recovery / close-tab-recovery / ...
├── proof-forgery / tamper-detection / ai-bulk-insert / synthetic-keystroke  (敵対的パック)
├── verify-web.spec.ts    # 検証 Web の往復: Web↔CLI パリティ・改ざん・複数ファイル (#215)・壊れた proof (#292)・タブを閉じたあとの active / 表示の一致 (#281)
└── production-build.spec.ts  # dist 専用スモーク (editor + /verify/。既定 config からは testIgnore で除外)
playwright.config.ts       # dev 用: webServer で workers(:8787) + editor vite dev(:5173) + verify vite dev(:5174)
playwright.build.config.ts # dist 用: workers + editor/verify を build し、verify を editor の dist の verify/ に重ねて vite preview(:4173)
scripts/setup-env.mjs      # CI 用: Turnstile 公開テストキー配置 + checkpoint 署名鍵を実行時生成
scripts/stage-verify-dist.mjs # dist 用: deploy.yml の「Merge build outputs」と同じ配置 (editor/dist/verify) を作る
```

## 実行

```bash
npm run install-browsers -w @typedcode/e2e   # 初回のみ
npm run setup -w @typedcode/e2e              # CI: テストキー + 署名鍵の用意
npm run test -w @typedcode/e2e               # 全シナリオ (サーバは Playwright が自動起動)
npm run test:build -w @typedcode/e2e         # 本番ビルドのスモークのみ (build → vite preview)
npm run test:headed -w @typedcode/e2e        # 失敗調査 (ブラウザ表示)
```

CI では `deploy.yml` の `e2e-shard` job が Playwright の `--shard=1/2` / `2/2` を matrix で並列に走らせ (`test:build` は shard 1 だけ)、集約 job **`e2e`** が全 shard の成功を要求する。`e2e` が main ruleset の required check であり、`deploy-preview` / `deploy-staging` / `deploy-production` の **必須ゲート** (`needs: [test, check, e2e]`) になっている。matrix の job は check 名が `e2e (shard 1/2)` に変わるので、**集約 job の名前 `e2e` と `if: always()` を外さないこと** (外すと shard 失敗時に skipped = ruleset 上は通過になる)。shard の手元再現は `npm run test -w @typedcode/e2e -- --shard=1/2`

### モード共通の入口 (helpers/app.ts)

- `openModeFresh(mode, { acceptTerms, screenShare, waitReady })`: `/<mode>?reset` で開く。利用規約は init script で localStorage `typedcode-terms-accepted` を入れて飛ばす (既定は casual 以外)。起動時の画面共有の選択ダイアログ (`.screen-share-choice-dialog`。class と exam で出ることを確認済み) は `screenShare: 'share' | 'optOut'` で選ぶ。問題の読み込み・試験ゲートは各モードの spec 側で足す
- export は `exportCurrentTab` / `exportAllTabs` (ダウンロードメニュー) と `exportViaLogButton` (問題パネルの `#download-log-btn`。exam はこちらに一本化される)
- `writeZipVariant` / `tamperFirstContentChange`: export ZIP を書き換えた ZIP (改ざん・proof の改名・壊れたエントリの追加) を作る。verify Web には ZIP のまま渡す

## よくある罠

- **`verify-cli` は tsx で src を直接実行**: build を待たずに済むよう `helpers/verifyCli.ts` が `tsx cli.ts` で src を直接実行する。配布物 `dist/cli.js` (esbuild の単一 ESM bundle, #298) が素の node で動くことは verify-cli の `npm run test:dist` が CI で担保する
- **打鍵直後の即リロードはイベント取り残し**: PoSW / IndexedDB flush 前に reload するとチェーンが途切れる。`waitForSynced` (`#sync-status-item.synced` + event-count 安定) を挟む。event-count が 30 秒以内に安定しなければ throw する (#229。以前は黙って return し、原因から離れた所で落ちていた)
- **`?reset` は localStorage を消す**: init script で入れた値も main.ts 先頭の `localStorage.clear()` で消える。利用規約の同意フラグは `Storage.prototype.clear` を包んで戻している (`installTermsAccepted`)。同じ手口で値を仕込むときはこれに倣う
- **verify Web の判定は「選んだファイル」のもの**: `#assurance-strip` / `#result-status-icon` は表示中のタブ 1 つ分しか持たない。`VerifyWebApp.readVerdict` はサイドバーの行を選んでから読む。同じ export から作った ZIP を 2 つ入れると表示名 (`data-filename`) が重なって行が定まらないので、`writeZipVariant({ renameProof })` で proof 名を変える。`data-status` が `success` のプレーンテキスト (README・ソース) に判定は付かないので、読むのは `*_proof.json` だけ
- **verify Web の完了待ちはサイドバーの全行で見る**: `#vp-step-*` は表示中のタブの進捗表示 (状態契約の外) なので待ちに使わない。`waitSettled` は全 `.file-item` の `data-status` が pending / verifying でなく、それが 2 回続けて同じになるまで待つ
- **`vite preview` は `server.proxy` を引き継ぐ**: editor の `preview.proxy: {}` を外すと `/verify` が dev の verify サーバへ転送され、本番ビルドのスモークで 502 になる
- **headless では本物の window blur が出ない**: `window.dispatchEvent(new Event('blur'))` で発火させる (handleBlur は isTrusted 非依存)
- **画面共有は fake-media フラグで動く**: `playwright.config.ts` の chromium 引数で `getDisplayMedia` が monitor の fake stream を返す
- **AI 一括投入の再現は dev フック経由**: `keyboard.insertText` は Monaco が 1 文字ずつ分解するため再現にならない。`window.__tcTestInsertBlock` (dev 限定) で `executeEdits` を 1 回適用する
- **dev サーバ向けの spec は本番ビルドの退行を検出できない (#255)**: チャンク分割・バンドル変換の壊れ方は `vite build` の出力にしか現れない。`production-build.spec.ts` + `playwright.build.config.ts` がその 1 本の番人で、`vite preview` に対して走る。dev フック (`__tcTestInsertBlock`) は dist に無いので、この経路の spec は増やすなら **dev 限定 API に依存しない**こと
