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

Playwright の `webServer` が 2 つのローカルサーバを自動起動する:

- **workers** (`wrangler dev` :8787) — `/api/session/start`・`/api/verify-captcha`・署名 CP
- **editor** (`vite dev` :5173) — テスト対象アプリ

`editor/.env` は Cloudflare の Turnstile **テストキー** (`1x00000000000000000000AA` =
常に pass) と `VITE_API_URL=http://localhost:8787` を指すので、追加設定なしで
Turnstile → workers 検証 → attestation 記録までフルスタックが回る。

## 実行

```bash
# 初回のみ: ブラウザ取得
npm run install-browsers -w @typedcode/e2e

# 全シナリオ実行 (サーバは Playwright が自動起動)
npm run test -w @typedcode/e2e

# 失敗調査
npm run test:headed -w @typedcode/e2e   # ブラウザを表示
npm run report -w @typedcode/e2e        # 直近の HTML レポート (trace 付き)
```

ローカルで既に `npm run dev` を回している場合は `reuseExistingServer` でその
サーバを再利用する (CI では毎回新規起動)。

## CI / 環境の用意

CI には `.dev.vars` も `editor/.env` も存在しない (gitignore)。`npm run setup`
([scripts/setup-env.mjs](scripts/setup-env.mjs)) が:

- Turnstile の Cloudflare **公開テストキー** (常に pass) を `editor/.env` に配置
- checkpoint 署名鍵を**実行時に新規生成**し、秘密 JWK を `workers/.dev.vars`、
  公開鍵を `shared/.../checkpointKeys/localKeys.ts` に書く (verifier が keyId 解決)

秘密情報は一切コミットしない。**ローカルに既存の `.dev.vars` があれば何もしない**
ので、開発者の skip-worktree な checkpoint 鍵 / Turnstile 設定を壊さない。

CI ジョブは `.github/workflows/deploy.yml` の `e2e`。`deploy-preview` /
`deploy-staging` / `deploy-production` は `[test, check, e2e]` でゲートされる。

## verify-cli の起動

shared の main が raw TypeScript のため `node dist/cli.js` は動かない
(verify-cli/CLAUDE.md の既知課題)。E2E は `tsx` で `src/cli.ts` を直接実行する。
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

Phase C 以降でフルスクリーン/画面共有/Turnstile 分岐/リロード復元/モードルーティング、
Phase D で敵対的パック (複数行 AI 一括投入など) / staging カナリア / ブラウザマトリクスを追加予定
(設計の全体像は本リポジトリの方針メモを参照)。
