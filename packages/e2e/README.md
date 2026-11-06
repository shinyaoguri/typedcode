# @typedcode/e2e

実物のエディタをブラウザで動かし、証明 (.tcproof / ZIP) を出力し、それを
`verify-cli` で検証する **round-trip テスト**。UI の見た目ではなく、暗号的に
検証可能な成果物をオラクルにするので flaky になりにくく、editor の記録系・
shared の検証系・CLI を 1 本で同時に検証できる。

## 仕組み

```
Playwright (Chromium) でシナリオ実行 → export → verify-cli で検証
  ① チェーン検証が pass / fail すること (exit 0 / 1)
  ② 記録イベント列がシナリオ台本と一致すること (--analysis-json で機械判定)
```

Playwright の `webServer` が 3 つのローカルサーバを自動起動する:

- **workers** (`wrangler dev` :8787) — `/api/session/start`・`/api/verify-captcha`・署名 CP
- **editor** (`vite dev` :5173) — テスト対象アプリ
- **verify** (`vite dev` :5174) — 検証 Web。export した ZIP を入れて、判定を data-* の状態契約で読む

`editor/.env` は Cloudflare の Turnstile **テストキー** (`1x00000000000000000000AA` =
常に pass) と `VITE_API_URL=http://localhost:8787` を指すので、追加設定なしで
Turnstile → workers 検証 → attestation 記録までフルスタックが回る。

## 実行

```bash
# 全シナリオ実行 (サーバは Playwright が自動起動)。
# pretest が `npm run setup` (テストキー + 署名鍵) と `npm run install-browsers` (Chromium) を先に走らせるので、
# npm ci 直後の新しい環境でもこれだけで通る。どちらも繰り返して安全 (既存の .dev.vars は上書きせず、導入済みなら何もしない)
npm run test -w @typedcode/e2e

# 本番ビルド (dist) のスモークだけを実行 (editor を build → vite preview)
npm run test:build -w @typedcode/e2e

# 失敗調査
npm run test:headed -w @typedcode/e2e   # ブラウザを表示
npm run report -w @typedcode/e2e        # 直近の HTML レポート (trace 付き)
```

ローカルで既に `npm run dev` を回している場合は `reuseExistingServer` でその
サーバを再利用する (CI では毎回新規起動)。ただし再利用するのは**この作業ツリーのサーバだけ**で、
テストより前に globalSetup (`global-setup.ts`) が各サーバの名乗る作業ツリーの識別子を照合する (#552)。
別の worktree のサーバや識別子を名乗らないサーバ (照合が入る前の版で動くもの・TypedCode 以外のプロセス) が
ポートを握っていると、テストを 1 本も走らせずに「ポート N は別の作業ツリーのサーバが使用中 (相手: <パス>)」の
形で落ちるので、そのサーバを止めるか `E2E_EDITOR_PORT` / `E2E_WORKERS_PORT` / `E2E_VERIFY_PORT` で
空きポートを指定する。本番ビルドのスモーク (`npm run test:build`) も、再利用しうる workers を
`global-setup.build.ts` で同じく照合する (#560。`E2E_WORKERS_PORT` で空きポートへ逃がせる)。**exam の spec は editor と verify を E2E 用の設定 (出題者鍵を差し替える `vite.editor.config.mjs` /
`vite.verify.config.mjs`) で起こすサーバが前提**なので、同じ作業ツリーの通常の `npm run dev` が 5173 / 5174 を握っていると、照合は通っても
「出題者の署名を検証できない」で落ちる。その場合も同じく空きポートを指定する。

### exam の fixture (#229)

`npm run setup` が `scripts/setup-exam-fixture.mjs` で `packages/e2e/fixtures/exam/` (gitignore 済み) に、
使い捨ての出題者鍵で署名・封印した問題パッケージ (v2 バンドル 1 問) を作る。封印は本物の出題者ツール
`packages/workers/scripts/make-exam-package.mjs` を spawn するので、shared との canonical serialization の
ドリフトも検出できる。出題者の**秘密鍵はディスクに残さない**。fixture は揃っていれば作り直さない
(作り直すなら `packages/e2e/fixtures` を消して `npm run setup -w @typedcode/e2e`)。

shared の `examAuthorityKeys/localKeys.ts` (開発者の鍵置き場。gitignore 済み) は**書き換えない** (書くと開発者の鍵を壊し、
e2e の後も手元の verifier が偽の出題者鍵を信頼し続ける。#229 / #338)。editor は `vite.editor.config.mjs`、verify Web は `vite.verify.config.mjs`、verify-cli は
`tests/helpers/verifyCli.ts` の `examAuthorityKeys: true` (`exam-keys/` の resolve フック) で、E2E の実行時だけ
`./localKeys` の import を fixture の公開鍵に差し替える。

### 本番ビルド向けの別設定 (#255)

上記の `npm run test` は **vite dev サーバ**に対して走るため、バンドル変換や
チャンク分割に起因する退行を原理的に検出できない。実際 #255 では
`vite-plugin-top-level-await` が monaco の関数巻き上げを壊し、**本番ビルドだけ
エディタが起動しない**状態で CI が緑のまま main に載った。

そのため [playwright.build.config.ts](playwright.build.config.ts) を別に持ち、
`vite build` → `vite preview` (:4173) に対して
[tests/production-build.spec.ts](tests/production-build.spec.ts) だけを走らせる
(`npm run test:build`)。verify も build し、deploy と同じく editor の dist の `verify/` に
重ねて ([scripts/stage-verify-dist.mjs](scripts/stage-verify-dist.mjs)) `/verify/` で開く。既定の `playwright.config.ts` は `testIgnore` でこの spec を
外しているので、dev 向けシナリオの挙動は変わらない。

## 見た目・動きの証跡 (`npm run shots`)

E2E は見た目を画素で比べないので、editor / verify の見た目・動きを変えた PR には本文に
before/after の画像を載せる ([ADR-0036](../../docs/adr/0036-visual-evidence-on-prs.md))。その素材を撮るのが
[tests/shots.spec.ts](tests/shots.spec.ts) (タイトルに `@shots`。何も assert しない) で、通常の
`npm run test` からは外してある。

```bash
npm run shots -w @typedcode/e2e   # packages/e2e/shots/ に PNG・アニメーション WebP・manifest.json を出す
```

- `manifest.json` は `[{file, caption}]` の配列で、何を撮ったかの正本
- 打鍵の様子はコマ撮りを `img2webp` (macOS: `brew install webp` / Debian: `apt-get install webp`) で
  可逆のアニメーション WebP に束ねる。`img2webp` が無ければ WebP だけ飛ばす
- `shots/` は gitignore 済み。画像はコミットせず Gyazo に上げて PR 本文に貼る (repo-standards
  プラグインの gyazo-capture スキル)。before は main で同じコマンドを打って撮る
- UI に触れた PR には、CI ([visual-evidence.yml](../../.github/workflows/visual-evidence.yml)) が base と head で
  このコマンドを回して before/after の表をコメントする。要る画面を本文の「見た目の証跡」へ写す

## 記録側 PoSW のベンチ (`npm run bench:posw`)

[tests/posw.bench.spec.ts](tests/posw.bench.spec.ts) (タイトルに `@bench`。何も assert しない) は、実エディタで打鍵と
マウス移動を一定のペースで流し、PoSW の処理待ち (backlog) が増え続けるかと、掃ける速さ (件/秒) を測る。
反復数の判断の根拠 ([ADR-0045](../../docs/adr/0045-lower-posw-iterations-for-recording-throughput.md)) を取った手順で、
通常の `npm run test` と CI からは外してある。

```bash
npm run bench:posw -w @typedcode/e2e                          # 1 倍と CPU 4 倍相当。packages/e2e/bench/ に JSON を出す
BENCH_ITERATIONS=1000 npm run bench:posw -w @typedcode/e2e    # 反復数を変えたときの見積もり (できる proof は検証に通らない)
```

- 4 倍相当は、メインスレッドに CDP の `Emulation.setCPUThrottlingRate`、PoSW の Worker には処理時間を 4 倍に
  引き延ばす busy-wait を差し込んで模擬する (CDP のスロットルは dedicated Worker に効かない)
- 読み方: `paced[].pendingEvery2s` が単調に伸びていれば、処理が入力に追いついていない。目安は ADR-0045 の「目安」
- 1 回あたり 2 本 × 約 2〜5 分。`bench/` は gitignore 済み

## CI / 環境の用意

CI には `.dev.vars` も `editor/.env` も存在しない (gitignore)。`npm run setup`
([scripts/setup-env.mjs](scripts/setup-env.mjs)) が:

- shared の 2 つの `localKeys.ts` (checkpoint 鍵と出題者鍵。gitignore 済み) が無ければ `.example` から作る
  (`npm install` の postinstall と同じ処理。`npm install` を通らない worktree 向け。既存は上書きしない / #338)
- Turnstile の Cloudflare **公開テストキー** (常に pass) を `editor/.env` に配置
- checkpoint 署名鍵を**実行時に新規生成**し、秘密 JWK を `workers/.dev.vars`、
  公開鍵を `shared/.../checkpointKeys/localKeys.ts` に書く (verifier が keyId 解決)

書き込む先はどれも gitignore 済みなので、setup の後も `git status` は clean のまま (#338)。
秘密情報は一切コミットしない。**ローカルに既存の `.dev.vars` があれば生成しない**
ので、開発者の checkpoint 鍵 / Turnstile 設定を壊さない。ただし
`.dev.vars` の `CHECKPOINT_SIGNING_KEY_ID` が `registry.ts` にも `localKeys.ts` にも無いときは、
直し方を表示して非 0 で終わる (#388)。`.dev.vars` と `localKeys.ts` は別々に消えたり作り直されたりするので
(片方だけ別の worktree から持ってきた、`localKeys.ts` が `.example` から作り直された、など)、
食い違ったままだと workers が署名を拒否して e2e が「署名 0 件」で落ちるため。

CI ジョブは `.github/workflows/deploy.yml` の `e2e-shard` (Playwright の `--shard` で 2 分割した
matrix。`test:build` は shard 1 だけ) と、全 shard の成功を要求する集約 job `e2e`。
`build-preview` / `deploy-staging` / `deploy-production` は `[test, check, e2e]` でゲートされ、
main ruleset の required check も `e2e`。

## verify-cli の起動

shared の main が raw TypeScript のため `node dist/cli.js` は動かない
(verify-cli/AGENTS.md の既知課題)。E2E は `tsx` で `src/cli.ts` を直接実行する。
ヘルパーは [tests/helpers/verifyCli.ts](tests/helpers/verifyCli.ts)。

## シナリオ (段階的に拡充)

**Phase A (基盤 + round-trip)**

| # | ファイル | 検証内容 |
|---|---|---|
| 1 | happy-path.spec.ts | /casual で入力 (括弧含む) → export → CLI 検証 pass、Pure Typing: YES |
| 9 | multi-tab-export.spec.ts | 複数タブ ZIP export → CLI が全 proof を検証 |
| 10 | tamper-detection.spec.ts | export 済み proof を改ざん → CLI が exit 1 (負のオラクル) |

**Phase B (入力完全性)**

| # | ファイル | 検証内容 |
|---|---|---|
| 2 | external-paste.spec.ts | 外部クリップボードを実ペースト → insertFromPaste 記録・Pure Typing: NO |
| 3 | internal-paste.spec.ts | 自分のコードを内部コピペ → insertFromInternalPaste (許可)・Pure Typing: YES |
| 4 | tab-switch.spec.ts | フォーカス喪失→復帰 → focusChange 記録・focus loss 計上 |
| 7 | synthetic-keystroke.spec.ts | 合成打鍵に isTrusted=false が付く (ADR-0018)・信頼打鍵には付かない |

**Phase C (モード/復元/メディア)**

| ファイル | 検証内容 |
|---|---|
| mode-routing.spec.ts | `/` と `/casual` は練習のエディタを直接開く (打鍵 → export → verify-cli)、未知パスは not-found 画面 (エディタ非初期化・`/` へのリンクだけ) |
| reload-recovery.spec.ts | 編集→リロード→復元→追記→export、チェーンがリロードをまたいで検証 pass |
| screen-share.spec.ts | 画面共有有効化 → screenShareStart + スクショ記録 → ZIP に screenshots/ → 検証 pass |
| exam-roundtrip.spec.ts | `/exam` で `.tcexam` を誤コードで拒否 (ゲートに留まる) → 正コードで解錠 → 打鍵 → export → `verify-cli --mode fast --exam-package` が exit 0 + Exam binding の PASS 行。別パッケージ・本物の registry では exit 1。署名 envelope ≥ 1 (#229) |

> reload-recovery は実装の **sessionStartToken 喪失バグ** (リロードで root アンカーが落ち
> proof が検証不能になる) を発見し、`editor` 側で修正した (editor↔shared をまたぐ統合バグ)。

**Phase D (敵対的パック)**

| ファイル | 検証内容 |
|---|---|
| ai-bulk-insert.spec.ts | Copilot/snippet 相当の単一編集での複数行コード投入 → Pure Typing: NO / 外部入力 / bulk として検出。打鍵は YES (区別) |
| proof-forgery.spec.ts | export 済み proof への 5 種の偽造 (nonce/fingerprint/複製/順序入替/切り詰め) を verify-cli が全て exit 1 で拒否 |

> ai-bulk-insert は実装の **検出漏れ** (executeEdits の複数行投入が insertParagraph で記録され
> bulk 検出を素通り) を発見し `shared` で修正した。内部ペースト (自分のコード) は監査マーカーと
> 同一内容を許可リスト化して誤検知を回避。AI 一括投入を実ブラウザで再現するため editor に
> dev 限定フック `__tcTestInsertBlock` (本番ビルドで除去) を追加。

**Phase E (検証 Web, #346)**

| ファイル | 検証内容 |
|---|---|
| verify-web-parity.spec.ts | export ZIP を検証 Web に入れ、data-* の状態契約 (status / integrity / temporal / pure-typing / 総合判定) が同じ ZIP に対する verify-cli の判定と一致する。改ざん ZIP は Web も CLI も拒否。version が新 major なら warning、下限未満なら拒否 (#223) |
| verify-web-submission.spec.ts | 正常 + 改ざんを一度に入れて判定が混ざらない (#215)。壊れた `*_proof.json` 入りの ZIP は、Web が error として並べ、CLI が exit 1 にする (#292)。同梱ソースを差し替えた ZIP は Web が error、CLI が exit 1 (#293) |
| verify-web-ui.spec.ts | アクティブなタブ / 最後のタブを閉じたあとのタブ・サイドバー・結果パネルの active の一致 (#281 / #387)、結果表示後にチャートのタブが押せる (#395) |
| production-build.spec.ts | 本番ビルドの verify (`/verify/`) が proof を読んで状態契約の属性を出す |

> Web↔CLI で比べられるのは合否 (`data-status` error ⇔ CLI の `valid=false`、総合判定 failed も同じ軸) と
> 三層保証 (`--analysis-bundle` の assurance)。success / warning・verified / partial の区別は Web だけの
> TrustCalculator の導出で、CLI に対応する出力が無いので比べていない。

残り (フルスクリーン / Turnstile 失敗分岐 / staging カナリア /
ブラウザマトリクス) は今後。macOS ネイティブ全画面・実 Turnstile チャレンジ・実ディスプレイの
画面共有ピッカーは手動スモーク。
