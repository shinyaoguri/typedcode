# packages/editor — AGENTS.md

`@typedcode/editor` は **キーストロークを記録して証明 ZIP を作る Monaco エディタアプリ**。

このファイルには、毎回読む責務・不変条件・罠の見出しだけを置く。理由・例外・表・一覧は [docs/](docs/) にあるので、下の「触る前に読む」で当たる文書を、コードを触る前に読む (置き場の規則は root の [AGENTS.md](../../AGENTS.md)「ドキュメント階層」)。

## 責務と境界

- **持つ**: Monaco との統合、イベント検出 (paste/drop/keyboard/mouse/focus/visibility)、PoSW 用 Web Worker のホスト、IndexedDB 永続化、ZIP エクスポート、Turnstile クライアント、署名済み cp の発行依頼
- **持たない**: 検証ロジック (verify 側) や暗号証明エンジン本体 (shared 側)。`TypingProof` のファサードを使うだけで、ハッシュ計算アルゴリズム自体には触らない

## 触る前に読む

| 触るもの | 先に読む |
|---|---|
| 下の不変条件に関わるコード (記録・署名・保存・export・救出・復元・起動時の容量の試験) | [docs/invariants.md](docs/invariants.md) の同じ番号 |
| どこに何があるか、記録と export の流れ | [docs/architecture.md](docs/architecture.md) (ディレクトリ一覧・データフロー) |
| `data-*` 属性・ダイアログ・dev フックと、それを読む E2E | [docs/state-contract.md](docs/state-contract.md) |
| `executors/`・`execution/`・`terminal/`・HTML プレビュー、`@wasmer/sdk`・Pyodide の更新 | [docs/pitfalls/code-execution.md](docs/pitfalls/code-execution.md) |
| モードの判定・試験の開始と解錠・授業 / 課題・`.tcexam` / `.tcclass`・問題パネル | [docs/pitfalls/modes.md](docs/pitfalls/modes.md) |
| `authoring/` (`/author`) | [docs/pitfalls/authoring.md](docs/pitfalls/authoring.md) |
| タブを閉じる・消す経路、IndexedDB のスキーマと接続、二重起動、離脱、スクリーンショット | [docs/pitfalls/storage-and-lifecycle.md](docs/pitfalls/storage-and-lifecycle.md) |
| IME・Monaco のイベント、ダイアログ、起動時の処理、対応ブラウザ、Vite の設定 | [docs/pitfalls/recording-ui-build.md](docs/pitfalls/recording-ui-build.md) |

## 重要な不変条件

ここは見出しで、全文 (理由・例外・回帰テスト) の正本は [docs/invariants.md](docs/invariants.md) の同じ番号。関わるコードを触る前に全文を読む。番号は変えない (コード・テスト・他の文書が番号で参照する)。足す・変えるときは、全文を docs/invariants.md に書き、ここには見出しを 1 行だけ置く。

1. **Event #0 は `humanAttestation`**: ファイル作成時の Turnstile 認証をチェーンの根として固定する。**他のイベントを #0 にしてはいけない**。casual/class は Turnstile を `/api/session/start` に統合し、initialize より先に実行して root をサーバアンカーする (ADR-0017)。作成時の認証全体は `TAB_CREATE_VERIFICATION_BUDGET_MS` で打ち切る (#375)
2. **`EventRecorder` は fire-and-forget**: PoSW 待ちで UI をブロックしない。代わりに `queuedEventCount` を露出して UI が表示する
3. **`SignedCheckpointService` は単一フライト**: 並列 `flush()` を許すと同一 cp の二重署名で `previousSignedCheckpointHash` チェーンが破綻する (ADR-0003)。**署名は `sessionStartToken` 前提** (ADR-0027) で、署名専用に取った token は root に焼かない。`TOKEN_EXPIRED` は恒久失敗にせず取り直す (#682)。export・保存・救出は token の取り直しの成否を待たない。`contentHash` が空の cp は enqueue しない (#571)。checkpoint の作成と署名の付与は永続化を要求する (#654)
4. **`InputDetector` の paste 検出**: `SessionContentRegistry` と照合して `insertFromPaste` (禁止) と `insertFromInternalPaste` (許可) を分ける。この判定がピュアタイピング判定の入口。**検出の範囲はイベントで分ける** (#697): paste / copy は Monaco のコンテナ、drop はエディタ領域のドロップゾーン (`.workbench`) で拾い、drop を聞く検出器は 1 つだけにする
5. **IndexedDB の書き込みは逐次**: イベント記録順序が崩れると復元時のチェーンが壊れる。同じ `(tabId, eventIndex)` への `appendEvent` は同じ hash の再 append だけを冪等な成功とし、hash が違えば `EventChainConflictError` で reject する (#484 / #237)。append は全文入りの tabs 行を書き直さない (#627)。所有権を失ったと分かったらラッチして書き込みを止める (#237)。チェーンに載るイベントは、確定したらその場で、確定順に `appendEvent` する (#471 / #873)。書き込みは transaction の `oncomplete` で成功とする (#543)。保存状態 (`#sync-status-item`) は永続化の成否を表し、export は保存の失敗で止めない
6. **エクスポート前 attestation**: `ProofExporter` の export (`exportAllTabsAsZip`) は Turnstile 検証を通す。ただし **exam / class は `preExportBestEffort=true`** で、Turnstile 不達/失敗でも失敗 attestation を記録して提出 ZIP を出す (ADR-0006/0011)。casual はブロックする。assignment は casual と同じ `false` で、`.tcclass` の方針が上書きする (#645)
7. **救出は Turnstile・PoSW・IndexedDB・ネットワークの成功に依存しない。救出ファイルは proof を含まない** (ADR-0042、#544): `RescueExporter` は待機・Turnstile・`flushToIndexedDB`・`waitForQueueDrain`・署名の `waitForFlush`・スクリーンショット・`exportProof()` を呼ばない。1 タブの読み出しの失敗で他のタブを止めない
8. **復元時に証明と食い違った元のコードを上書き・削除しない** (ADR-0042 段階 2、#413): 復元はバッファを replay 版にして proof を valid に保ち、元の content は `unprovenContents` ストアに追記のみで残す。このストアに put・delete の経路を作らない。元のコードをバッファへ自動で戻さない
9. **起動時の空き容量の試験は、セッション DB とは別の DB に書いて消し、容量不足でも起動を止めない** (#626): 警告であってゲートではない。容量切れは `QuotaExceededError` の名前だけで判定しない。結果はハッシュチェーンに記録しない

## 状態契約 (data-* 属性)

E2E (`packages/e2e`) は editor の UI 状態を、翻訳テキストや CSS クラスではなく [docs/state-contract.md](docs/state-contract.md) の表に挙げる **data-\* 属性** と dev 限定フック `__tcTestSnapshot` で読む ([ADR-0034](../../docs/adr/0034-replace-manual-verification-with-automated-tests.md)、#433)。値は生の値 (id・言語 id・enum) で、翻訳しない。既存の class (`active` / `synced` など) や表示テキストはそのまま残してあり、契約はそれに**足した**もの。

- 全表のほか、`data-dialog` の名前、dev フック (`__tcTestSnapshot` など)、E2E 側の読み手も docs/state-contract.md にある。属性を足す・変えるときは表を同じ PR で直す
- **この契約 (要素・属性名・値域・「無い」の意味・snapshot の形) を変えるときは、`packages/e2e` の E2E と同じ PR で変える**。片方だけ変えると E2E が赤になるか、もっと悪いと別の要素を読んで黙って通る。契約を固定しているユニットテストの一覧も docs/state-contract.md にある

## よくある罠

見出しだけを場面別に並べる。本文 (理由・経緯・回帰テスト) は各ファイルにあり、同じ見出しで始まる。その場面のコードを触る前に本文を読む。罠を足すときは、本文を場面のファイルに書き、ここには見出しを 1 行足す。

### コード実行 — [docs/pitfalls/code-execution.md](docs/pitfalls/code-execution.md)

- `@wasmer/sdk` を上げたら本番ビルドで C を動かす (#364)
- C / C++ の利用者のソースには何も前置しない (#709)
- C++ のコンパイルは `-xc++` を渡さず、libc++ の版の `#warning` を `-include` の guard で黙らせる (#871)
- C / C++ のリンクには `-lwasi-emulated-process-clocks` を渡す (#714)
- HTML プレビュー iframe は opaque origin (#291/#299)
- ユーザーの JS / TS は opaque origin の sandbox iframe 内の Worker でだけ実行する (#290 / ADR-0041)
- Python (Pyodide) は、エディタのメインスレッドでも同じ origin でも動かさない (#649 / #719 / ADR-0047 / ADR-0056)
- Wasmer の `Process.kill()` は、走っている wasm を止めない (#711 の実測)
- 対話の実行の stdin の行規律はターミナルが持つ (#707)
- C / C++ の実行系は、最初の実行まで読み込まない (#617)
- 非対話の実行 (一括検証の基盤) は対話の実行の挙動を変えない (#802 / ADR-0051)

### 入口とモード — [docs/pitfalls/modes.md](docs/pitfalls/modes.md)

- 問題の入出力例は表示するだけで、判定も記録もしない (#648 / ADR-0048)
- 入口は学生にモードを選ばせない (ADR-0046、#644。ADR-0015 のランディングを置き換え)
- 試験モードはパスで入る (ADR-0011, ADR-0010 の sticky を置換)
- 試験モードの暗号コア解錠 (ADR-0006)
- 試験の許可言語は境界ごとに判定する (#727)
- 授業/課題モードの平文問題配布 (ADR-0014/0015)
- `.tcclass` の方針 (`policy`) は入口の能力より優先する (#645)
- 入場時の初期状態 (ADR-0015)

### 作問画面 (`/author`) — [docs/pitfalls/authoring.md](docs/pitfalls/authoring.md)

- 教材フォルダのハンドルはセッション DB と別の IndexedDB に置く (#795 / ADR-0051)
- 教材フォルダの定義ファイルは `authoring/workspace/definitions.ts` を通して書く (#794 / ADR-0051)
- 作問画面の状態は `AuthorWorkspace` に置き、開いている文書のファイルを裏で読み直さない (#796 / ADR-0051)
- ファイルの種類ごとの表示は `authoring/ui/documentViews.ts` に登録する (#797)
- 問題のコピーは保存済みの内容から作り、コピー先を覚えない (#800 / ADR-0051)
- ケースファイルのフォームは、利用者が触った欄だけを文書に書く (#798)

### 保存・タブ・インスタンスのライフサイクル — [docs/pitfalls/storage-and-lifecycle.md](docs/pitfalls/storage-and-lifecycle.md)

- beforeunload は「確認」と「状態保存」を別のフラグで分ける (#445)
- `SingleInstanceGuard` の判定は Web Locks で、時間に依存させない (#494)
- `SingleInstanceGuard` はページを離れるとき (`pagehide`) にだけ破棄する (#483)
- スクリーンショットは「チェーンに記録できるときだけ」保存する (#503)
- タブを閉じる後始末は順序が要る (#342)
- exam を除き、利用者の明示の操作なしに、コードとイベントを IndexedDB から削除しない (#317 / ADR-0057。例外は、復元で見つけたイベント列の飛びより後の行を `unprovenContents` へ写してから消すことだけ = #878 / ADR-0058)
- IndexedDB のバージョンマイグレーション
- IndexedDB の接続のライフサイクル (#325)

### 入力の記録・ダイアログ・起動・ビルド — [docs/pitfalls/recording-ui-build.md](docs/pitfalls/recording-ui-build.md)

- `vite-plugin-top-level-await` を再導入しない (#255)
- ダイアログは `ui/components/dialogA11y.ts` の `attachDialogA11y` を使う (#305)
- 起動時ワンショットは「セッションのスナップショット型」に登録する (#405)
- IME の composition は Monaco の `onDidCompositionStart` / `onDidCompositionEnd` で取る (#720)
- `editor.inComposition` で確定の編集を判定しない (#720)
- Monaco の `onDidChangeModelContent` イベントは ICustomEvent ではない
- ビルド時に注入される `__GIT_COMMIT__` 等
- 記録させるのは Chromium 系だけ (#596 / ADR-0033)

## i18n

- `src/i18n/translations/{ja,en}.ts` に翻訳を追加
- `src/i18n/types.ts` の `TranslationKeys` に **必ず** 同じキーを追加 (宣言済みセクション内のキーは型エラーで漏れを検出。ただし index signature があるため**新規トップレベルセクション**の追加漏れは型では拾えない点に注意)
- ロケール検出: localStorage → ブラウザ言語 → `ja`
