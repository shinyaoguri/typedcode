# packages/e2e — CLAUDE.md

`@typedcode/e2e` は **実物のエディタをブラウザで動かし、証明を export して verify-cli で検証する round-trip E2E**。editor の記録系・shared の検証系・CLI を 1 本で同時に検証する。

## 責務と境界

- **持つ**: Playwright (Chromium) でのシナリオ駆動、export ZIP の取得、verify-cli の spawn と exit code / `--analysis-json` 判定、敵対的パック (偽造・改竄・合成打鍵・AI 一括投入) の負のオラクル
- **持たない**: UI の見た目 assert (暗号的に検証可能な成果物をオラクルにするので flaky になりにくい)、ユニットテスト (各パッケージの `__tests__` が担う)、proof 生成/検証ロジック本体 (editor / shared)

## 重要な不変条件

1. **オラクルは verify-cli の結論**: 「編集 → export → verify-cli が pass/fail」を軸にする。DOM の見た目ではなくチェーン検証の exit code / analysis JSON で判定する
2. **負のオラクルを必ず持つ**: 改竄シナリオは verify-cli が **exit 1 で拒否する**ことを assert する (1 種でも素通りすると「壊れた検証器」を緑と誤認する)。positive control (無改竄が pass) と対で置く
3. **信頼打鍵と合成打鍵を区別**: Playwright の `keyboard.type` は CDP 経由で `isTrusted=true`。合成打鍵 (ADR-0018) は `page.evaluate(dispatchEvent)` で `isTrusted=false` を注入する
4. **CI 時間を意識**: PoSW full 検証は重い。改竄など PoSW 無関係なシナリオは `--mode fast` を使い、happy 系はコードを短くする (deploy.yml の e2e job は `timeout-minutes: 30`、実測 ~18 分)

## 構成

```
tests/
├── helpers/app.ts        # EditorApp ページオブジェクト + ZIP/proof 読み出しヘルパ
├── helpers/verifyCli.ts  # tsx で verify-cli/src/cli.ts を直接実行 (raw TS の ESM 解決回避)
├── happy-path / multi-tab-export / reload-recovery / close-tab-recovery / ...
└── proof-forgery / tamper-detection / ai-bulk-insert / synthetic-keystroke  (敵対的パック)
playwright.config.ts      # webServer で workers(:8787) + editor(:5173) を自動起動
scripts/setup-env.mjs     # CI 用: Turnstile 公開テストキー配置 + checkpoint 署名鍵を実行時生成
```

## 実行

```bash
npm run install-browsers -w @typedcode/e2e   # 初回のみ
npm run setup -w @typedcode/e2e              # CI: テストキー + 署名鍵の用意
npm run test -w @typedcode/e2e               # 全シナリオ (サーバは Playwright が自動起動)
npm run test:headed -w @typedcode/e2e        # 失敗調査 (ブラウザ表示)
```

CI では `deploy.yml` の `e2e` job が実行し、`deploy-preview` / `deploy-staging` / `deploy-production` の **必須ゲート** (`needs: [test, check, e2e]`) になっている。

## よくある罠

- **`verify-cli` は tsx で src を直接実行**: shared が raw TS (`src/index.ts`) のため `node dist/cli.js` は `ERR_MODULE_NOT_FOUND`。`helpers/verifyCli.ts` が `tsx cli.ts` で回避する
- **打鍵直後の即リロードはイベント取り残し**: PoSW / IndexedDB flush 前に reload するとチェーンが途切れる。`waitForSynced` (`#sync-status-item.synced` + event-count 安定) を挟む
- **headless では本物の window blur が出ない**: `window.dispatchEvent(new Event('blur'))` で発火させる (handleBlur は isTrusted 非依存)
- **画面共有は fake-media フラグで動く**: `playwright.config.ts` の chromium 引数で `getDisplayMedia` が monitor の fake stream を返す
- **AI 一括投入の再現は dev フック経由**: `keyboard.insertText` は Monaco が 1 文字ずつ分解するため再現にならない。`window.__tcTestInsertBlock` (dev 限定) で `executeEdits` を 1 回適用する
