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
# 初回のみ: ブラウザ取得
npm run install-browsers -w @typedcode/e2e

# 全シナリオ実行 (サーバは Playwright が自動起動)
npm run test -w @typedcode/e2e

# 本番ビルド (dist) のスモークだけを実行 (editor を build → vite preview)
npm run test:build -w @typedcode/e2e

# 失敗調査
npm run test:headed -w @typedcode/e2e   # ブラウザを表示
npm run report -w @typedcode/e2e        # 直近の HTML レポート (trace 付き)
```

ローカルで既に `npm run dev` を回している場合は `reuseExistingServer` でその
サーバを再利用する (CI では毎回新規起動)。

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

## CI / 環境の用意

CI には `.dev.vars` も `editor/.env` も存在しない (gitignore)。`npm run setup`
([scripts/setup-env.mjs](scripts/setup-env.mjs)) が:

- Turnstile の Cloudflare **公開テストキー** (常に pass) を `editor/.env` に配置
- checkpoint 署名鍵を**実行時に新規生成**し、秘密 JWK を `workers/.dev.vars`、
  公開鍵を `shared/.../checkpointKeys/localKeys.ts` に書く (verifier が keyId 解決)

秘密情報は一切コミットしない。**ローカルに既存の `.dev.vars` があれば何もしない**
ので、開発者の skip-worktree な checkpoint 鍵 / Turnstile 設定を壊さない。

CI ジョブは `.github/workflows/deploy.yml` の `e2e-shard` (Playwright の `--shard` で 2 分割した
matrix。`test:build` は shard 1 だけ) と、全 shard の成功を要求する集約 job `e2e`。
`deploy-preview` / `deploy-staging` / `deploy-production` は `[test, check, e2e]` でゲートされ、
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
| mode-routing.spec.ts | `/`・未知パスはランディング (エディタ非初期化・4カード)、`/casual` は明示ルート、カードから遷移 |
| reload-recovery.spec.ts | 編集→リロード→復元→追記→export、チェーンがリロードをまたいで検証 pass |
| screen-share.spec.ts | 画面共有有効化 → screenShareStart + スクショ記録 → ZIP に screenshots/ → 検証 pass |

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
| verify-web.spec.ts | export ZIP を検証 Web に入れ、data-* の状態契約 (status / integrity / temporal / pure-typing / 総合判定) が同じ ZIP に対する verify-cli の判定と一致する。改ざん ZIP は Web も CLI も拒否。正常 + 改ざんを一度に入れて判定が混ざらない (#215)。壊れた `*_proof.json` 入りの ZIP は、Web が error として並べ、CLI が exit 1 にする (#292) |
| production-build.spec.ts | 本番ビルドの verify (`/verify/`) が proof を読んで状態契約の属性を出す |

> Web↔CLI で比べられるのは合否 (`data-status` error ⇔ CLI の `valid=false`、総合判定 failed も同じ軸) と
> 三層保証 (`--analysis-bundle` の assurance)。success / warning・verified / partial の区別は Web だけの
> TrustCalculator の導出で、CLI に対応する出力が無いので比べていない。

残り (フルスクリーン = exam ゲート + .tcexam fixture / Turnstile 失敗分岐 / staging カナリア /
ブラウザマトリクス) は今後。macOS ネイティブ全画面・実 Turnstile チャレンジ・実ディスプレイの
画面共有ピッカーは手動スモーク。
