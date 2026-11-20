# packages/e2e — AGENTS.md

`@typedcode/e2e` は **実物のエディタをブラウザで動かし、証明を export して verify-cli (と検証 Web) で検証する round-trip E2E**。editor の記録系・shared の検証系・CLI・verify の表示を 1 本で同時に検証する。

このファイルには、毎回読む責務・不変条件・罠だけを置く。理由・例外・表・一覧は [docs/](docs/) にあるので、下の「触る前に読む」で当たる文書を、コードを触る前に読む (置き場の規則は root の [AGENTS.md](../../AGENTS.md)「ドキュメント階層」)。

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

## 触る前に読む

| すること | 先に読む |
|---|---|
| spec を足す・探す、helper や設定ファイルの役割を知る | [docs/layout.md](docs/layout.md) (spec と設定ファイルの一覧) |
| nightly・本番ビルド・staging・ベンチ・証跡の回し方、CI のシャード、`helpers/app.ts` の入口 | [docs/running.md](docs/running.md) |
| spec が不安定・環境で落ちる、新しい操作を書く | [docs/pitfalls.md](docs/pitfalls.md) |

## 構成

`tests/` の spec・helper と、設定ファイルの一覧は [docs/layout.md](docs/layout.md)。spec を足したら、その一覧に 1 行足す。

## 実行

```bash
npm run test -w @typedcode/e2e               # 全シナリオ (サーバは Playwright が自動起動)。pretest が setup と install-browsers を先に走らせる (#335)
npm run test:build -w @typedcode/e2e         # 本番ビルドのスモークのみ (build → vite preview)
npm run test:headed -w @typedcode/e2e        # 失敗調査 (ブラウザ表示)
```

- nightly・staging (`test:deployed`)・証跡 (`shots`)・ベンチ・セットアップのコマンドと、CI のシャードは [docs/running.md](docs/running.md)
- **`@nightly` は通常の実行と CI のシャードから外れる** (`playwright.config.ts` と `playwright.build.config.ts` の grepInvert。`@shots` と同じ扱いで、`NIGHTLY=1` のときだけ含める)
- **editor の UI 状態は状態契約と `expectConsistent()` で判定する** (#433)。`helpers/app.ts` の入口 (`openModeFresh` など) は docs/running.md

## よくある罠

見出しだけを並べる。本文 (理由・経緯・回避の書き方) は [docs/pitfalls.md](docs/pitfalls.md) にあり、同じ見出しで始まる。罠を足すときは、本文を docs/pitfalls.md に書き、ここには見出しを 1 行足す。

- 別の作業ツリーのサーバは再利用しない (#552)
- exam の出題者鍵は開発者の鍵置き場に書かない (#229, #338)
- exam の解錠は Argon2id がメインスレッドで同期に走る
- `verify-cli` は tsx で src を直接実行
- 待ちの既定は 30 秒で、`waitFor` 系にも効く (#584)
- class のリロードに `reloadAndResume()` は使えない
- 打鍵直後の即リロードはイベント取り残し
- URL を開くだけで保存データは消えない (#323)
- verify Web の判定は「選んだファイル」のもの
- verify Web の完了待ちはサイドバーの全行で見る
- `vite preview` は `server.proxy` を引き継ぐ
- headless では本物の window blur が出ない
- 画面共有は fake-media フラグで動く
- 画面共有の停止は `track.stop()` では再現できない
- API の障害は 1 つずつ塞ぐ
- `setOffline` は読込後にだけ使う
- 長い composition は文字数ぶんのイベントになる (#783)
- 打鍵した改行は `\r\n` になる
- undo / redo は Ctrl 系で押す
- `page.clock` の時刻表記は `hh:mm:ss`
- AI 一括投入の再現は dev フック経由
- 保存済みの `currentHash` を書き換える改ざんは、tabs 行と `tabProgress` の両方を書き換える (#627)
- dev サーバ向けの spec は本番ビルドの退行を検出できない (#255)
