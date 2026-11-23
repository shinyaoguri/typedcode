# @typedcode/editor

エディタ本体アプリケーション。Monaco Editor をベースにした、連続タイピングを証明するエディタです。ブラウザ内でコード実行まで完結します。

## 機能

- **マルチタブ編集**: タブごとに独立した証明チェーン、タブ切替も追跡
- **対応言語**: C, C++, Python, JavaScript, TypeScript
- **テーマ**: ライト/ダークモード (システム設定の自動検出)
- **イベント追跡**: キーストローク・カーソル・ペースト/ドロップ・ウィンドウ・フォーカス・可視性などを記録 (一覧は [`@typedcode/shared` の `events.ts`](../shared/src/types/events.ts))
- **PoSW**: 反復シーケンシャルハッシュを Web Worker で計算 (反復数は `POSW_ITERATIONS` 固定)
- **スクリーンショット**: 定期撮影とフォーカス喪失時の撮影、ハッシュ検証付き
- **時刻アンカリング**: チェックポイントを Workers で ECDSA-P256 署名し、サーバ時刻と結びつける
- **人間認証**: ファイル作成時とエクスポート前に Cloudflare Turnstile を実行
- **エクスポート**: 証明 JSON・ソースコード・スクリーンショット・README を含む ZIP アーカイブ
- **i18n**: 日本語と英語の UI

## 対応ブラウザ

Chromium 系のブラウザ (Chrome・Edge・Opera・Brave など) だけで記録できます。E2E を Chromium でしか回していないため ([ADR-0033](../../docs/adr/0033-e2e-round-trip-harness-as-deploy-gate.md))、Safari と Firefox (と iOS のブラウザ。iOS では Chrome も WebKit で動く) は起動時に「サポートされていないブラウザです」の画面で止め、証明を記録させません (#596)。判定はユーザーエージェント (UA) の文字列だけで行います (`src/app/browserSupport.ts`)。

## ブラウザ内コード実行

| 言語 | ランタイム | 補足 |
|----------|---------|---------|
| C | Wasmer SDK | Clang WASM、stdin/stdout 対応。**`clock()` は実時間** (プログラムの開始からの経過時間) を返す。ネイティブの C のような CPU 時間ではなく、入力待ちや `sleep` の間も進む。`CLOCK_PROCESS_CPUTIME_ID` も実時間で、この環境で CPU 時間を測る手段は無い (`getrusage` / `times` は正しい値を返さない)。刻みは 1 ミリ秒程度。値はブラウザ上の WebAssembly (`-O2`。ランタイムの初期化は含まない) での経過時間なので、ネイティブ環境の計測とは比べられない (#714) |
| C++ | Wasmer SDK | C と同じ Clang WASM。**`<iostream>` は使えない** (コンパイルが終わらない)。`<string>` / `<vector>` / `<array>` / `<memory>` / `<algorithm>` など C++ 標準ライブラリのヘッダも同じく、終わらないかコンパイラが落ちる。入出力は `<cstdio>` (`std::printf` / `std::scanf`) を使う。原因はコンパイラ (clang 16) と同梱の libc++ ヘッダ (19) の版の食い違い ([#490](https://github.com/shinyaoguri/typedcode/issues/490))。この食い違いで libc++ が出す版の警告 (`#warning`) は、ターミナルに出さない ([#871](https://github.com/shinyaoguri/typedcode/issues/871)) |
| Python | Pyodide | CPython を WebAssembly にしたもの。jsdelivr から読み込む |
| JavaScript | ネイティブ | ブラウザ eval + console キャプチャ |
| TypeScript | Monaco 同梱の TypeScript worker (`getEmitOutput`。型チェックなし) | JS にトランスパイルしてから JavaScript と同じ sandbox で実行 |

## 開発

```bash
npm run dev      # http://localhost:5173
npm run build
npm run preview
```

## 主要な仕組み

### イベント記録の流れ

```
User Action
    ↓
InputDetector (paste/drop 検出)
    ↓
OperationDetector (Monaco 変更イベント → 操作種別。IME の composition 系は CompositionTracker が composition に対応付けた編集にだけ付ける)
    ↓
KeystrokeTracker / MouseTracker など
    ↓
EventRecorder (キューイング、fire-and-forget)
    ↓
TypingProof.recordEvent() (@typedcode/shared)
    ↓
HashChainManager → PoswManager (Web Worker)
    ↓
StoredEvent → IndexedDB (イベント本体) + sessionStorage (タブ状態)
```

> IME の変換入力 (`insertCompositionText` / `insertFromComposition` / `deleteCompositionText`) は、Monaco の `onDidCompositionStart` / `onDidCompositionEnd` と編集の範囲を対応付けて分類します (#720)。文字種では推定しないので、composition を経ない複数文字の 1 行の挿入は、日本語などを含んでいても `insertReplacementText` として記録されます。

> proof データを localStorage に置くことはありません。イベント本体は IndexedDB (`typedcode-session`)、タブ状態は sessionStorage (`typedcode-tabs`) に保存されます (モード別に名前空間化)。

### Fire-and-Forget 記録

UI をブロックせずにイベントを記録します。

1. `record(event)` は即座に返る
2. PoSW 計算は Web Worker で実行 (反復数は `POSW_ITERATIONS` 固定)
3. UI は処理中の件数を `queuedEventCount` で表示
4. イベントは IndexedDB へ逐次保存

これにより暗号処理の負荷があってもタイピングの応答性が保たれます。

### 内部ペースト検出

外部からの貼り付け (Ctrl+V) と、同一セッション内の自己コピーを区別します。

1. タイプされたコンテンツは `SessionContentRegistry` に登録
2. ペースト発生時、貼り付けテキストを登録済みコンテンツと照合
3. 一致 → `insertFromInternalPaste` (許可、ピュアタイピングを破らない)
4. 不一致 → `insertFromPaste` (禁止、外部入力としてマーク)

これにより、自身がタイプしたコードのコピー＆ペーストはペナルティなしで許容されます。

### 署名付きチェックポイント (時刻アンカリング)

直前のチェックポイントから **100 イベント** または **10 秒** のいずれかが先に成立した時点でチェックポイントを生成し、Workers の `/api/checkpoint/sign` で ECDSA-P256 署名と `serverTimestamp` を付与します。

- ネットワーク不安定下でも堅牢なよう、`SignedCheckpointService` はシングルフライトで順次フラッシュ
- 同一内容の再送はサーバ側の冪等処理 (`isIdempotentSigningRetry`) で吸収
- 署名失敗してもチェーン本体は継続 (best-effort)

### セッション復旧

ブラウザの再読み込みや予期せぬ終了に備えます。

1. イベントは IndexedDB へ逐次保存
2. リロード時に `sessionResumed` イベントを記録
3. 直前の保存状態からハッシュチェーンを継続
4. PoSW の計算待ちだったイベントは復元しない (チェーンに載らない。下の「[保存の時点と、失われうる範囲](#保存の時点と失われうる範囲)」)

### テンプレート注入

試験のスターターコードなどテンプレートをロードする場合の扱い。

1. `templateInjection` イベントを記録
2. 注入されたコンテンツはユーザータイプ分とは別に追跡
3. ピュアタイピング判定はテンプレートとユーザー入力を区別して評価

## 保存の時点と、失われうる範囲

入力した内容がいつブラウザの保存領域に書き込まれ、ブラウザやタブが落ちたときに何が失われうるか、どう取り戻すかをまとめます (#894)。保存先の一覧は [system-spec §5.1](../../docs/system-spec.md) にあります。イベント本体と、エディタの内容を含むタブの行、閉じたタブは IndexedDB (`typedcode-session`) に、リロードで使う軽量なタブ状態 (イベントを含まない) は sessionStorage (`typedcode-tabs`) に置きます (名前はモード別に名前空間化)。sessionStorage はリロードでは残り、タブを閉じると消えます。

### 保存までの遅れ

| 何を | どこへ | いつ |
|---|---|---|
| 証明のイベント (打鍵など) | IndexedDB | PoSW の計算が済んでハッシュチェーンに確定したとき、その場で 1 件ずつ、確定した順に書く |
| エディタの内容とタブの状態 | IndexedDB、続けて sessionStorage | 記録の受付や確定があるたびに保存を予約し、最後の予約から 100ms 次の予約が来なかったときにまとめて書く (`TabManager` の `SAVE_DEBOUNCE_MS`)。打ち続けている間や PoSW の計算待ちが続く間は予約が延び続けるので、書くのは手が止まった後になる |
| 同上 (ページを離れるとき) | sessionStorage だけ | `beforeunload` で同期的に書く (リロードの復元用)。IndexedDB への書き込みは待たない |

PoSW の計算待ちのイベント (処理待ち) はメモリにしか無く、IndexedDB にも sessionStorage にも書きません。処理待ちがある間、ステータスバーの保存状態は「保存待ち」になります。

### ブラウザやタブが落ちたときに失われうるもの

- **証明に残らないもの**: 落ちた時点で処理待ちだったイベントと、確定していても IndexedDB への書き込みが完了 (transaction の commit) していなかったイベント。処理待ちの量は PoSW の計算の遅れで決まるので、決まった秒数ではなく、端末の速さと打鍵の量で変わります。リロードでも処理待ちのイベントは復元しません
- **エディタに出る内容**: 再開すると、保存済みのイベントから組み立て直した内容 (証明に載っている版) を出します。保存済みのエディタの内容がこれと食い違うとき (処理待ちの打鍵が内容にだけ残っていたときなど) は、元の内容を「証明に記録されなかった編集」として消さずに残し、通知から差分の表示とダウンロードができます ([system-spec §5.4.1](../../docs/system-spec.md))。証明には入らないので、要る部分はエディタに打ち直します
- 保存済みのエディタの内容は、ブラウザごと落ちた (`beforeunload` を経ない) ときは最後に保存が済んだ時点のもの、リロードのときは離れる直前のもの (sessionStorage) です

### 保存に失敗したとき

ステータスバーの保存状態 (`#sync-status-item`) は、PoSW の進み具合ではなく保存の成否を表します (定義は `src/ui/tabs/syncStatus.ts`)。

| 表示 | 意味 |
|---|---|
| 同期済み | IndexedDB と sessionStorage の両方に保存でき、処理待ちも無い |
| 同期中... | 保存している |
| 保存待ち | 保存の予約中か、処理待ちのイベントがある |
| 一部のみ保存 | IndexedDB か sessionStorage の片方にだけ保存できた |
| 保存失敗 | どちらにも保存できなかった |

- 「一部のみ保存」「保存失敗」は、次の保存が成功するまで表示を変えません (打鍵で「保存待ち」に戻さない)。失敗した保存は 2 秒から倍々に、最大 60 秒の間隔で試し直します (`TabManager` の `SAVE_RETRY_INITIAL_MS` / `SAVE_RETRY_MAX_MS`)。その間に新しい入力があれば、その保存が試し直しを兼ねます
- IndexedDB への保存の失敗が容量切れらしいときは、セッション中 1 回だけ「保存できませんでした。ディスクの空き容量が不足している可能性があります」と通知します。保存先 (IndexedDB) に接続できなくなったときと、新しい版が別のタブで開かれたときも通知します
- 1 つのタブのイベントが非常に多い (約 50 万件) と、sessionStorage への保存が容量超過で失敗し、IndexedDB に保存できていても保存状態は「一部のみ保存」になります。その間、リロードで使うタブ状態は更新されません (#874)
- 保存に失敗していても、証明のエクスポートは止めません (証明はメモリ上のチェーンから作ります)
- 起動時にも空き容量を試し (書き込む量は [system-spec](../../docs/system-spec.md) の `STORAGE_PROBE_BYTES`)、書けなければ警告を出します。警告であって、「このまま続ける」で使い続けられます

### ブラウザが保存領域を消しうること

TypedCode は `navigator.storage.persist()` を呼ばず、保存領域を消さないようブラウザに求めていません。このため保存領域はブラウザの都合で消せる扱い (best-effort) で、ディスクの空きが逼迫すると、ブラウザが利用者に確認せずにこのサイトのデータ (IndexedDB を含む) を消すことがあります。利用者がブラウザの閲覧データ (サイトのデータ) を削除したときも消えます。TypedCode 自身は容量の監視も、逼迫したときの削除もしません。ブラウザ内の保存だけに頼らず、提出するものと残したいものは、エクスポートか救出でファイルに書き出してください。

### 取り戻す方法

- **リロード**: 同じタブを再読み込みすると、確認なしに続きから復元します (sessionStorage のタブ状態と、IndexedDB のイベント)
- **タブやブラウザを閉じた後・落ちた後**: 同じモードを開き直すと「前回のセッションが見つかりました」が出て、「再開する」で IndexedDB から復元します。試験以外では、「新規セッション」を選んでも既定の「前回のファイルを残す」なら、前回のファイルは閉じたタブとして残ります
- **閉じたタブから開き直す** (#317 / #876、[ADR-0057](../../docs/adr/0057-keep-closed-tabs-as-archive.md)): 試験以外では、閉じたタブのコードと記録を IndexedDB に残し、メインメニューの「閉じたタブ」から開き直すと続きから記録できます。自動では消さず、消えるのは「完全に削除する」とリセットを選んだときだけです (ブラウザが保存領域ごと消したときを除く)。試験ではタブを閉じると削除し、この項目も出しません。扱いの一覧は [system-spec §5.1](../../docs/system-spec.md)
- **救出** (#300 / #544、[ADR-0042](../../docs/adr/0042-rescue-code-before-proof.md)): 設定メニューの「コードを救出 (証明なし)」(問題パネルがあるときは、パネル下部の「ログをダウンロード」の隣にもある) は、IndexedDB・認証・PoSW・ネットワークの成否を待たずに、エディタの内容とメモリ上の記録、残してある「証明に記録されなかった編集」をファイルに書き出します。保存に失敗しているときや IndexedDB に接続できなくなったときでも、コードを持ち出せます。証明ではないので提出の正本にはなりません。形式は [system-spec §5.4](../../docs/system-spec.md)

## 環境変数

| 変数 | 説明 | 必須 |
|----------|-------------|----------|
| `VITE_TURNSTILE_SITE_KEY` | Turnstile サイトキー | 任意 |
| `VITE_API_URL` | Workers API のエンドポイント | 任意 |

## ビルド時に注入される情報

ビルドプロセスは以下の変数をソースに注入します。

```typescript
__APP_VERSION__      // ビルドに渡した版 (TYPEDCODE_VERSION。タグ名から v を除いたもの。未指定なら dev+<コミット>)
__GIT_COMMIT__       // Git commit hash
__GIT_COMMIT_DATE__  // Git commit の日付
__BUILD_DATE__       // ビルド時刻
```

## 依存関係

版は各パッケージの `package.json` を参照してください (README には書き写しません)。

| パッケージ | 用途 |
|---------|---------|
| @typedcode/shared | 証明エンジンと型定義 |
| monaco-editor | コードエディタ本体 |
| @xterm/xterm | ターミナルエミュレータ |
| @xterm/addon-fit | ターミナルの自動リサイズ |
| @wasmer/sdk | WebAssembly ランタイム |
| dompurify | 問題パネルの markdown 描画のサニタイズ |
| jszip | ZIP エクスポート |
| marked | 問題パネルの markdown 描画 |
| yaml | テンプレート YAML 解析 |
| vite | ビルドツール (rolldown) |
| vite-plugin-wasm | WASM サポート |

## スクリーンショット機能

スクリーンショットは以下のタイミングで取得されます。

- 定期取得 (間隔は設定可能)
- フォーカス喪失時 (window blur)
- 手動操作

ストレージ: IndexedDB + SHA-256 ハッシュ検証
エクスポート: ZIP 内 `screenshots/` ディレクトリ + `manifest.json`
