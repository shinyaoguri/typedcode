# Changelog

このファイルは TypedCode の主要な変更を記録します。

書式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠し、
バージョニングは [Semantic Versioning](https://semver.org/lang/ja/) に従います。

リリースは `v*` タグの push で production へ配信されます (タグ式 GitHub Flow、[ADR-0028](docs/adr/0028-tag-based-github-flow.md))。

## [Unreleased]

### 追加

- 検証の部品関数の照合 6 箇所を、関数を直接呼んで確かめるテストを足した (`verification.components.test.ts`)。`verifyInitialHashRoot` の deviceId と fingerprint components、`verifyFinalChainHash` の `typingProofData.finalEventChainHash`、`verifyCheckpoints` の cp の順序・timestamp・contentHash について、条件を外すと赤くなる。仕様と実装は変えていない (#500)
- ZIP の予算付きリーダー (`readZipEntryBytes`) と空エントリ判定 (`isJszipEmptyEntry`) を守るテストを足した。予算超過時の `pause()`・stream の `error` での reject・複数チャンクの連結を、`isJszipEmptyEntry` の 5 条件それぞれを緩めると赤になる入力とあわせて固定し、`packages/shared/AGENTS.md` の不変条件 9 (形の判定を緩めると `zipBudget.test.ts` が止める) を実測と一致させた (#501)
- 試験 (exam) モードの round-trip E2E を足した (`packages/e2e/tests/exam-roundtrip.spec.ts`)。誤コードはゲートに留まり、正コードで解錠 → 打鍵 → export した ZIP を `verify-cli --mode fast --exam-package` に通すと exit 0 と束縛 (Root binding / Signature / Package hash / Content hash) の PASS 行が出る。別の問題パッケージと本物の registry では exit 1。fixture は `npm run setup` が `make-exam-package.mjs` で生成し、shared の追跡ファイル `examAuthorityKeys/localKeys.ts` は書き換えず、E2E の実行時だけ出題者鍵を差し替える (#229)
- 検証 (Web) で複数 proof を読み込んだとき、全件の検証が終わったあともステータスバーに `N/M proofs passed` と失敗件数を残すようにした (警告は passed に数える。plaintext・画像は数えず、読めない `*_proof.json` は失敗に数える)。失敗があれば押して最初に失敗した proof を開ける。状態契約に `#queue-status[data-proof-total/passed/failed]` を追加 (#282)
- `verifyProofFile` のセッション開始トークンの sessionId 照合 (別セッションのトークン流用を弾く。ADR-0017) と、署名 cp が無効なら全体を無効にする判定 (ADR-0020) を shared のテストで守るようにした (`verification.sessionToken.test.ts`)。これまでは verify の `webCliParity.test.ts` でしか捕まらなかった。仕様・実装の変更なし (#499, 親 #467)

- 変異検査 (#467) の系統 3・4 を守るテストを shared に足した (`verification.metadata.test.ts`、仕様・実装の変更なし)。`verifyProofFile` の `metadataValid` は `typingProofHash` の不一致と root の不一致のどちらか片方だけでも落ち、申告メタデータ (`pasteEvents` など 6 キーと `totalTypingTime`) を偽って `typingProofHash` を再計算した proof は拒否される。貼り付け・ドロップ・削除を含む正規 proof は `valid: true` のまま (#498)

- 検証の「厳しくする向き」の変異検査 (#467) で生き残った 3 箇所について、正規の proof が通ることを確かめる正の対照テストを足した (`verification.positiveControls.test.ts`)。timestamp が同値で連続するチェーン、置換・削除 (`rangeLength > 0`) を含む replay、templateInjection / contentSnapshot の後に contentChange が続く replay が `valid: true` になる。仕様の変更なし (#502)

### 変更

- URL に `?reset=<値>` を付けて開くだけで、確認なしに全モードの localStorage・sessionStorage・session DB が消える仕組みを撤去した ([ADR-0011](docs/adr/0011-course-modes-and-path-routing.md) の決定どおり)。設定メニューの Reset All は確認ダイアログに消えるモード名とタブ数を出し、**現在のモードの session DB とモード別のキーだけ**を消す (ほかのモードのデータ、規約同意・表示言語・テーマ・Cookie は残る)。自分の DB 接続を閉じ、削除の完了を待ってからパラメータ無しの URL でリロードする。試験の開始画面から `?reset` の案内 (`exam.gate.resetHint`) を外した (#323, #446)
- ランダムな操作列 (タブの追加・切替・改名・閉じる・打鍵・外部ペースト・内部コピペ・言語変更・リロード・フォーカス喪失・export) を実エディタに流し、各手の後にモデルと状態契約を突き合わせて最後に全 proof を verify-cli で検証する model-based E2E を足した。PR ゲートは固定シード 2 本、毎晩の `e2e-nightly.yml` はランダムシードの長い列を回し、失敗はシードと縮約後の操作列を Issue に集める (#436)
- 見た目・動きの証跡 (静止画と可逆のアニメーション WebP) を撮る撮影専用の E2E spec (`@shots`) と `npm run shots -w @typedcode/e2e` を足し、editor / verify の見た目を変える PR は本文に before/after の画像を載せる規律を置いた ([ADR-0036](docs/adr/0036-visual-evidence-on-prs.md))。通常の E2E と CI のシャードからは外している (#391)
- fast モードの検証で PoSW を再計算していないことを Web / CLI の双方で明示し、整合性 (integrity) を `proven` に上げず `partial` として扱うようにした ([ADR-0031](docs/adr/0031-integrity-partial-when-posw-skipped.md))。合否判定と proof フォーマットは変更なし (#253)
- `npm run dev` の開発サーバポートをセット単位で自動割当し、editor の `/verify` プロキシと `VITE_API_URL` を実際の割当ポートへ追従させた ([ADR-0030](docs/adr/0030-dev-port-autoswitch.md))。個別起動 (`dev:editor` など) は従来どおり固定ポート (#197)
- README 群を実装に合わせて刷新し、実在しない検証機能の記述 (overclaim) や古い API 契約を解消した (#249)
- 依存パッケージを更新した (dompurify、postcss、sharp、wrangler、shell-quote、concurrently、GitHub Actions ほか) (#199, #200, #201, #204, #205, #206, #209)
- PoSW 検証 (full モード) の反復を同期 SHA-256 (`@noble/hashes`) に置き換え、1 反復ごとの `await crypto.subtle.digest` を廃止した。出力は同一で、Node (verify-cli) では約 19 倍高速 (#267)
- `make-exam-package.mjs` の既定 deadline を `2999-12-31T23:59:59.999Z` (オープン) に変更し、`--release` / `--deadline` の説明を ADR-0013 と `/author` に揃えた。既定のまま作ったパッケージで全提出が「窓外 (advisory)」と表示されるノイズを解消 (#271)
- 呼び出し元ゼロの dead API を削除した: `TabManager` の `exportSingleTab` / `exportAllTabs` / `reset` / `getActiveContent` / `getSessionService`、`SessionStorageService` の `pruneOldSessions` / `truncateEvents` / `updateTabContent` / `updateTabMetadata`、shared の `MultiFileExportedProof` / `MultiFileExportEntry` / `isMultiFileProof` / `AnyExportedProof`、`beforeunload` での legacy スクリーンショット DB 削除 (#284, #231)
- 拡張子 → 言語の判定を verify から shared の実装へ一本化した (挙動の変更なし) (#278)
- `index.html` に一度も存在しなかった `clear-log-btn` のクリア配線 (`LogViewerPanelOptions.clearButtonId`・`setupClearButton`・`LogViewer.clear()`・`notifications.clearLogConfirm`) を削除した。ボタンは HTML に無かったので利用者に見える挙動は変わらない (#443)

### 修正

- C / C++ のコンパイルエラーの行番号が、`CExecutor` が先頭に足す preamble (6 行) の分だけずれ、エディタへのマーカー表示で Monaco が `Illegal value for lineNumber` を投げていた問題を修正した。preamble の末尾に `#line 1` を置いて clang 自身に元の行番号を出させ (端末のメッセージも `main.c:1:` になる)、`showErrorsInEditor` は範囲外の行 (モデルの行数超過・1 未満) を最終行 / 1 行目に寄せて例外を投げない (#489)
- コード実行の結果 (ADR-0021 の `codeExecution` の `phase` / `outcome` / `exitCode` / `elapsedMs`) が proof に入らず、export した proof の `codeExecution` が全件 `data: null` になっていた問題を修正した。`main.ts` の `onRecordEvent` が `data` を落として `type` と `description` だけを `eventRecorder.record()` に渡していたため、`processSummary` の `hasRunResults` が常に「結果不明」側に倒れていた。配線を `toRecordEventInput` に切り出して `data` も渡す。過去の proof は ADR-0021 の互換規定 (data:null は開始のみ・結果不明) で読める (#491)
- 設定メニューのリセット項目 (`settings.resetAll`) が ja / en とも英語の「Reset All」のままで、挙動 (現在のモードのデータだけを消す) と食い違っていた。確認ダイアログの確定ボタンに合わせて、ja「このモードをリセット」/ en「Reset This Mode」にした。利用規約の保存データの注記 (`terms.dataStorageNote`) が指す機能名も同じ名称にした。キー名 `resetAll` は変えていない (#505)
- exam の試験ゲート (タブが無い間) に撮れたスクリーンショットが、チェーンに `screenshotCapture` を残さないまま保存されて export ZIP の manifest に入り、解錠後の撮影で verifier が tampered と判定して正当な答案が `Integrity: FAILED` になる問題を修正した。`ScreenshotTracker.handleCapture` は callback (チェーンへの記録先) が無いとき保存しない (#503)
- 離脱確認で「このページに留まる」を選ぶと、`SingleInstanceGuard` が `beforeunload` で破棄されたまま残り、2 つ目のタブが正規インスタンスとして起動してハッシュチェーンを二重に伸ばせてしまう問題を修正した。破棄を `pagehide` (`persisted === false`、実際にページを離れるとき) に移した。bfcache に入る (`persisted === true`) ときは破棄せず、戻る操作で復元されたページのガードもそのまま生きている (#483, 親 #237)
- 同じセッションを 2 つのインスタンス (凍結復帰したタブと再開したタブなど) が書いたとき、`SessionStorageService.appendEvent` が同じ seq の hash の食い違いを黙って吸収し、タブ行の `currentHash` を後から書いた側で上書きしていた問題を修正した。同じタブ・同じ seq に別の hash を書こうとすると `EventChainConflictError` で拒否し (events・タブ行は変えない)、同じ hash の再 append (保存の再試行・二重書き込み) は冪等に成功してタブ行を書き換えない。`assertOwner()` で、別インスタンスに `resumeSession` された側を `SessionOwnershipError` で検出できる。競合したタブは `TabManager` の保存でスナップショットの上書きを飛ばしてログに残す (検出時の read-only 化・UI は #237 PR-3) (#484, #237)
- `proof.version` と試験パッケージのバージョンが検証の入口でゲートされていなかった問題の shared 側を修正した (#223。表示層は後続の PR)。`verifyProofFile` が `proof.version` を厳密な `MAJOR.MINOR.PATCH` として分類し (`classifyProofVersion`)、`MIN_SUPPORTED_VERSION` 未満・不正形式・欠落は `valid: false` (`errorMessage` に version)、既知 major を超えるものは reject せず `versionStatus: 'newer'` を結果に載せる。`isVersionSupported('abc')` が false になる。`parseExamPackageManifest` は `EXAM_PACKAGE_FORMAT_VERSION` と異なる `formatVersion` を (正規署名でも) 拒否し、理由を返す `parseExamPackageManifestResult` を足した。`verifyExamBinding` は `proof.exam.examProofVersion` が `EXAM_PROOF_VERSION` と異なる proof を束縛失敗にする (欠落は 1)。現行の proof (1.0.0〜1.2.0) の検証結果は変わらない
- #223 の表示層。verify-cli は `proof.version` が検証器の知る major を超えるとき合否の直下に warning を出し (exit code は他の検査で決まる)、下限未満・不正形式・欠落は `Error:` に version の理由を出す (自己申告の生値は stdout に出さず、数字に正規化した値だけ)。verify (Web) は信頼バッジに「形式バージョン」の warning / error を足し (`.trust-issue-item[data-component][data-severity]` を状態契約に追加)、タブの状態も同じ軸にする。`.tcexam` の取込 (verify-cli の `--exam-package`・verify の問題パッケージ読込・editor の試験ゲート) は「壊れている」「より新しい形式」「もう対応しない形式」を出し分ける (ゲートは `#exam-gate-error[data-reason]`)。現行の proof の表示は変わらない (#223)
- `/api/checkpoint/sign` が `sessionStartToken` の古さを見ず、署名鍵が生きている限り同じ token が無期限に有効だった問題を修正した。`issuedAt` から 30 日 (`SESSION_TOKEN_MAX_AGE_MS`) を超えた token は 401 `TOKEN_EXPIRED` で拒否する (KV には触れない)。検査は sign 経路だけで、検証器は age を見ないので過去の proof の採点は変わらない。editor は `TOKEN_EXPIRED` を恒久失敗にせず署名の queue を保ち、`findSigningToken` が sessionId の一致する中で `issuedAt` が最新の token を選ぶので、後から開いたタブの新しい token で全タブの署名が再開する。期限切れの token しか無くても export は止まらない ([ADR-0027](docs/adr/0027-checkpoint-sign-requires-session-token.md)) (#227)
- 打鍵していないタブを export すると、同期状態 (`#sync-status-item[data-state]`) が `pending` のまま戻らない問題を修正した。export の直前の flush がデバウンス中の保存を取り消して自分で保存するのに、状態を確定させていなかった。flush の最後で、その間に新しい保存要求が無ければ保存の完了と同じ規則 (PoSW 待ちのイベントが残っていれば `pending`、無ければ `synced`) で確定させる (#456)
- 打鍵が 100 件の倍数に達して contentSnapshot が記録されたとき、ステータスバーのイベント数とハッシュ (`#event-count[data-count]` / `#current-hash[data-hash]`) が次のイベントまで 1 件遅れたまま残る問題を修正した。スナップショットの記録が済んだら表示を追従させる (#448)
- 空のタブ (0 バイトのファイル) を含めて全タブ export した ZIP を、verify-cli / verify Web が `ZIP entry has no readable declared size` で拒否する問題を修正した。JSZip が 0 バイトのエントリに作る形 (申告サイズを持たない空の中身を STORE で持つ) と完全に一致するエントリだけを 0 バイトとして数え、それ以外の申告サイズが読めないエントリは従来どおり fail-closed で拒否する。申告 0 を詐称しても JSZip は中身を捨てるので展開は起きない (#447)
- 「閉じて再開」の復元が tabs レコードの古い `currentHash` を採用し、定期保存と append の競合で再開後のチェーンが切れて proof が invalid になりうる問題を修正した。`TypingProof.restoreState` が events 末尾の hash を正とし (events が空のときだけ渡された値を使う)、editor の 3 つの復元経路すべてに効く。V2 経路の個別の補正は重複になるので削除。proof 形式・ハッシュ入力の変更なし (#322)
- Workers の `GET /api/checkpoint/public-keys` が body の `cacheTtlSec` (86400) と `Cache-Control: max-age=3600` で食い違う TTL を返していた問題を修正した。body から `cacheTtlSec` フィールドを削除し、キャッシュは `Cache-Control: public, max-age=3600` に一本化した。リポジトリ内にこのフィールドを読む側は無い (#370)
- editor から Workers への fetch (verify-captcha / session/start / checkpoint/sign) にタイムアウトが無く、回線が止まると試験の export・タブ作成・署名が無期限に止まりうる問題を修正した。各 fetch を `WORKERS_FETCH_TIMEOUT_MS` で打ち切って既存の失敗経路 (リトライ・署名の backoff 再試行) に合流させ、exam / class / assignment の export 前認証は全体を `PRE_EXPORT_VERIFICATION_BUDGET_MS` で打ち切って失敗 attestation を記録したうえで ZIP を出す。casual の export 前認証は従来どおり待つ (#324)
- タブ復元で `tabOrder` が空配列 (セッション作成直後の初期値) や一部欠けていると、保存済みのタブ行が黙ってスキップされ、IndexedDB に残っているのに UI から開けないタブになりうる問題を修正した。復元順は tabOrder の順に、tabOrder に無い保存済みタブを末尾に足して全件復元する (#326)
- focus-burst 分析器がハッシュ対象外の `insertLength` を集計しており、整合性 `proven` の proof でも書き換えでシグナルを消したり作ったりできた問題を修正した。挿入文字数はハッシュ対象の `data` の長さで数え、`runAnalysis` は分析器へ渡すイベントをハッシュ対象のフィールドだけに射影する (#328)
- workers の署名・入力まわりを硬化した。署名鍵のキャッシュが `keyId` だけで引かれ、同じ `keyId` のまま JWK が差し替わっても検知できなかった問題を直し、署名のたびにレジストリ公開鍵との対応 (`SIGNING_KEY_MISMATCH`) と有効性 (`SIGNING_KEY_INVALID`: 失効・有効期間外・日時不正) を検査する (HTTP 500、クライアントへは固定文言)。全 POST の本文を読み込み中に 8KiB で打ち切り、不正 JSON は 400 を返し (verify-captcha / verify-attestation は 500 だった)、Turnstile トークンの型・長さ (≤2048) も外部呼び出しの前に検査する。verify-captcha / verify-attestation の予期しない例外をログに出し、全レスポンスに `X-Content-Type-Options` / `Referrer-Policy` / `Content-Security-Policy` を付与した (#285)
- ZIP 内の壊れた `*_proof.json` (JSON 破損・proof 構造なし) が黙って無視され、有効な proof だけで PASS / exit 0 になる問題を修正した。verify-cli は proof の命名 (`*_proof.json` / `*_proof_N.json`) に当たるのに読めないファイルを失敗として数え (ファイル名と理由を表示、exit 1。他の proof の検証は止めない)、verify Web は同じファイルを通常の JSON ではなく error として表示する。`extractAllProofsFromZip` の戻り値は `{ proofs, failures }` になった (#292)
- 試験束縛の検証が `proof.exam` の `examId` / `variant` (旧形式の単一問題では `problemId` も) を package と照合しておらず、これらを書き換えた proof も束縛合格になり、CLI / Web が自己申告値を検証済みのように表示していた問題を修正した。署名済み package と食い違えば束縛失敗とし、束縛合格時のみ package 側の識別子を表示する。package 未提供・束縛失敗のときは「自己申告」と明示する (#273)
- verify-cli が位置引数の 1 件目しか検証せず、`valid.json broken.json` や `valid.json does-not-exist.json` が未検証のまま exit 0 になる問題を修正した。複数の位置引数をすべて検証し、読めない・壊れている入力は他の入力を止めずに失敗として数え、1 件でも失敗すれば exit 1 にする。複数入力のときの ZIP 内 proof は `<入力>:<エントリ名>` で表示する (#294)
- 記録キューの排出が完了しないまま export され、content とチェーンが食い違う (検証すると invalid になる) proof が生成される問題を修正した。排出待ちを進捗ベースにし、排出できなかった場合は export を中止して通知する (#250)
- 検証 (Web) がフォルダ読み込み時にスクリーンショットのチェーン裏付け検査を行わず、ZIP で開いた場合と結論が変わる問題を修正した。あわせて、チェーンに記録があるのに manifest に存在しないスクリーンショット (剥ぎ取り) を Web でも警告するようにし、「0 枚」と「未検査」を区別して表示する (#251)
- 検証 (Web) が `sessionStartToken` と署名チェックポイントの `sessionId` を突合しておらず、別セッションのトークンを流用した proof を「整合性: 証明済み」と表示していた問題を修正した。あわせて署名チェックポイントの不備をハッシュチェーンの失敗として誤って帰属していた表示も是正した (#252)
- 試験束縛の検証で提出時刻の time-box を失格条件として扱っていた問題を修正した ([ADR-0013](docs/adr/0013-exam-schedule-advisory-keep-manifest-format.md) は advisory と定めている)。締切を過ぎた提出というだけで束縛が invalid になり、root アンカー gate の試験免除が外れ保証等級まで下がるうえ、提出時刻を渡さない検証 (Web) と CLI で結論が食い違っていた。time-box を `valid` から外し、CLI の表示も PASS/FAIL ではなく advisory と分かる文言に改めた (#220)
- ZIP のヘッダに書かれた解凍後サイズを詐称すると 256 MB の展開ガードを素通りし、検証 (Web) / verify-cli が ZIP 内の全データを展開してしまう問題を修正した。展開中の実バイト数を数えて上限で中断するようにし、JSZip から直接読み出す経路をテストで塞いだ (#234)
- 単一タブ export の事前認証を best-effort 化し、class / assignment モードで Turnstile が不達のときに提出用 ZIP を一切出力できなくなる問題を修正した (失敗 attestation はチェーンに記録される) (#244)
- HTML プレビューで、HTML タブが無い状態を経由すると再表示しても空のままになる不具合を修正した (#299)
- verify-cli の終了コードの既定を 1 (fail-closed) にし、解決しない `--analyzer` で処理が途中で終わっても改ざんされた proof が exit 0 にならないようにした (#315)
- editor の共通モーダル (`showModal`) と About ダイアログに、`role="dialog"` / `aria-modal` / `aria-labelledby`、初期フォーカス、Tab の閉じ込め、閉じたあとの起点へのフォーカス復帰を付けた (`ui/components/dialogA11y.ts`)。ボタンや overlay で閉じても document の keydown リスナーが残り、開閉のたびに Escape の処理が溜まる問題と、非同期 `onClick` 実行中の再クリック・Escape で二重に閉じる問題も解消した。`closeOnOverlayClick: false` のダイアログ (画面共有エラーの再試行モード) は Escape でも閉じなくなる。他のダイアログの移行は段階的に行う (#305)
- 同じ対応を、復旧ダイアログ・提出前セルフレビュー・書き出しの進捗・テンプレート取込 (確認と進捗)・画面共有の選択とオプトアウト確認にも広げた。自前で持っていた Escape のリスナーは `dialogA11y` に寄せ、どの経路で閉じても解放する。復旧・セルフレビュー・進捗は Escape で閉じない (セルフレビューは従来どおり。書きかけのノートを一つのキーで失わせない)。書き出し中の Turnstile ウィジェットへ Tab で入れるよう、Tab 巡回の対象に iframe を加えた。静的モーダル・タブ閉じ確認・`CountdownDialog` / lock overlay は未移行 (#305)
- 起動時に一度だけ記録するイベント (`termsAccepted`・初期の `windowResize` / `networkStatusChange`・`environmentProbe`・`screenShareOptOut`) が、記録した時点にあるタブにしか載らず、起動時にタブを作らない授業 / 課題モードのタブと、2 個目以降に作ったタブの proof から欠落していた問題を修正した。EventRecorder がこれらの最新の値をセッションのスナップショットとして保持し、新しく作ったタブに 1 回ずつ記録する (起動時にあったタブ・復元したタブには重ねない)。proof 形式・ハッシュ入力の変更なし (#405)
- verify-cli を esbuild で単一 ESM ファイルに bundle し、ビルド済み `dist/cli.js` が素の Node で起動するようにした。配布物の smoke test (`npm run test:dist`) を CI に追加 (#298)
- 記録に失敗してチェーンに載らなかったイベントが、直前のイベントを指す index で成功扱いになり、LogViewer と IndexedDB へ二重投入されていた問題を修正した。`RecordEventResult` に `recorded` を足し、載らなかったときは `recorded: false` / `index: -1` を返す (チェックポイント作成など push 後の失敗は載っているので `recorded: true`)。EventRecorder は載らなかったイベントを UI / IndexedDB に流さない。proof 形式・ハッシュ入力の変更なし (#284)
- 複数行にまたがる短い削除 (2〜49 文字) が `deleteWordBackward` に分類されていた問題を修正した。行をまたぐ削除は長さによらず `deleteHardLineBackward` とする。Monaco の変更イベントは削除文字列を持たないため、この分類と削除方向は推定 (advisory)。proof 形式・ハッシュ入力の変更なし (#284)
- リロードで復元するたびに、`tab-switches.json` へ `fromTabId: null` の合成タブ切替が 1 件ずつ蓄積していた問題を修正した。復元中は復元済みの履歴を使い、合成エントリを足さない。proof 形式・ハッシュ入力の変更なし (#284)
- 署名 API の per-session タブ台帳を record と別の KV 名前空間 (`tabs:{sessionId}`) に移し、`sessionId` / `tabId` を `[A-Za-z0-9._-]` に制限した。`tabId=tabs` で台帳が壊れて後続タブの署名が例外になる問題と、区切り文字 `:` による record キー衝突を解消。KV の不正形な record / 台帳でも未捕捉例外にならない (#297)
- 検証 (Web) の表示不整合をまとめて修正した。信頼バッジのハッシュチェーン issue に worker の英文がそのまま出ていた、スクリーンショットの解像度が欠けた displayInfo で `undefined x undefined` になる、問題パッケージ未提供の試験束縛カードが root 束縛だけで緑 (success) になり導線が畳まれていた、問題パッケージ (.tcexam) の manifest がキューのクリア後も残る、といった問題の解消。あわせて到達不能な `PoswMode` の `sampled` と未使用の i18n キーを削除した (#281)
- 検証 (Web) でアクティブなタブやファイルを閉じたあと、タブバー・サイドバー・結果パネルの選択が食い違い、閉じたはずのファイルの判定が表示されたままになる問題を修正した。次のタブの選択を TabController に一本化し、未オープンのファイルを選ばないようにした。あわせて、タブを閉じたあとに別の proof へ問題パッケージ (.tcexam) が束縛される経路と、フォルダ削除後にサイドバーの選択が残る問題も解消した。状態契約に `data-active` / `#result-status-card[data-filename]` を追加 (#281)

### セキュリティ

- HTML プレビュー iframe を `sandbox="allow-scripts allow-modals allow-forms"` の opaque origin で隔離し、プレビュー内のスクリプトから親画面・localStorage・IndexedDB (proof の保存先)・トップレベル遷移・ポップアップに届かないようにした。内容の投入は srcdoc に一本化し、スクロール位置の保存/復帰は postMessage 経由になった (#291)
- 公開鍵レジストリの `validFrom` / `validUntil` / `revokedAt` が parse 不能な日時 (手書き運用での typo) だと鍵の有効性検査そのものがスキップされ、失効させたはずの鍵が黙って信頼される問題を修正した。日時が読めないエントリはそのエントリだけ信頼しない (fail-closed) ようにし、判定を署名チェックポイント / セッション開始トークン / 出題者鍵の 3 消費者で共有する実装に一本化した。あわせて出荷されるレジストリの日時形式を検査するテストを追加し、typo を CI で止めるようにした (#233)
- proof の `mode` を allowlist で検証したうえでエスケープし、検証サイトのオリジンで任意 HTML が実行できる XSS を塞いだ (#245)
- proof の `events` 各要素の構造を検証し、null 要素を積んで `metadata.totalEvents` を水増しする偽造を塞いだ (#246)

## [1.1.0] - 2026-07-07

本リポジトリで最初のタグ付きリリースです。これ以前の変更履歴は本ファイルでは網羅せず、
主要な変更のみを記載しています (全 PR の一覧は
[GitHub Release v1.1.0](https://github.com/shinyaoguri/typedcode/releases/tag/v1.1.0) の自動生成ノートを参照)。

### 追加

- 試験モード: 封印した問題パッケージを監督コードで解錠し、proof のチェーン root を試験にバインドして採点時に検証する `/exam` ([ADR-0006](docs/adr/0006-exam-mode-sealed-problem-binding.md) / [ADR-0010](docs/adr/0010-exam-session-model.md))。タブ固定・リロード復帰・フルスクリーン要求と記録を含む (#74, #76, #77, #78, #79)
- 授業 / 課題 / 試験のモードをパスで分岐し、モードごとに機能 (スクリーンショット取得など) を切り替える構成 ([ADR-0011](docs/adr/0011-course-modes-and-path-routing.md))。セッションストレージもモード別に名前空間化 (#82, #83, #84)
- 授業モード: 封印しない問題配布 ([ADR-0014](docs/adr/0014-class-mode-unsealed-problem-distribution.md)) (#97)
- 教員向けオーサリング UI `/author`: N 問バンドルの試験パッケージを生成する ([ADR-0012](docs/adr/0012-sealed-starter-template-in-exam-payload.md)) (#87, #88, #90, #91, #92)
- 検証と直交する pluggable 分析層 ([ADR-0009](docs/adr/0009-pluggable-analysis-layer.md)): `environmentProbe` の捕捉と、自動化・転写トポロジー・focus↔バーストの各分析器 (#71, #72, #73)
- 分析 evidence を検証 Web / CLI に配線し、シークバーへ接続。CLI には `--analysis-json` 出力を追加 (#101)
- 三層保証語彙 (時刻 / 整合性 / 来歴) を実際の証拠から機械導出して UI と CLI に表示 ([ADR-0020](docs/adr/0020-three-layer-assurance-vocabulary.md)) (#102)
- プロセス要約の抽出と表示、検証 Web の再生モード・見どころマーカー (#103)
- コード実行結果の加算的な捕捉とデバッグサイクルの抽出 ([ADR-0021](docs/adr/0021-code-execution-result-capture.md)) (#104)
- 提出前セルフレビューと振り返りノート `reflectionNote` ([ADR-0022](docs/adr/0022-pre-export-self-review.md)) (#105)
- verify-cli の外部アナライザ差込み口 `--analyzer` と、分析プラットフォーム方針 ([ADR-0023](docs/adr/0023-analysis-platform-not-judge.md)) (#108)
- Tier A 分析バンドルのエクスポート ([ADR-0024](docs/adr/0024-data-minimization-tiers.md)) (#112)、および採点者向けコホート基準の純粋関数 ([ADR-0025](docs/adr/0025-grader-cohort-baseline.md)) (#113)
- LogViewer での `codeExecution` / `reflectionNote` の可読表示 (#114)
- セッション開始時の ECDSA トークンによるチェーン root のサーバアンカー、署名チェックポイントのアンカー密度シグナル、合成打鍵の `isTrusted` 捕捉 ([ADR-0016](docs/adr/0016-anchoring-density-signal.md) / [ADR-0017](docs/adr/0017-server-anchored-chain-root.md) / [ADR-0018](docs/adr/0018-istrusted-capture.md)) (#99)
- エディタ支援機能 (補完など) の実効状態を `environmentProbe` に宣言 ([ADR-0019](docs/adr/0019-editor-assist-declaration.md)) (#100)
- ブラウザ E2E テスト基盤 (実エディタでの編集 → export → verify-cli 検証の round-trip) と、それを deploy のゲートにする CI ジョブ (#116, #117, #118)
- editor / verify / author を機能別アクセントカラーで判別できるようにした (#94)

### 変更

- `/author` を editor と同じクロム構造 (titlebar / activitybar / workbench / statusbar) の Monaco オーサリング UI に統一 (#92, #95)
- Biome (lint + format) と `tsconfig.base.json` を導入し、品質ゲートを typecheck 以外にも広げた (#185)
- ブランチ運用をタグ式 GitHub Flow へ移行し、`v*` タグ push を production デプロイの起点にした ([ADR-0028](docs/adr/0028-tag-based-github-flow.md)) (#188)

### 削除

- 打鍵動態の表示を分析レポートへ統合し、旧 TypingPatternCard を廃止した (#115)

### 修正

- リロードや IndexedDB からの復旧時に `sessionStartToken` が引き継がれず、root アンカーを喪失する問題 (#117, #159)
- セッション復元時に content をチェーンの replay 結果へ整合させるようにした (#177)
- export をスナップショット一貫にし、export 中の記録との競合を解消した (#178)
- `firstSeenAt` が既知の値と食い違う envelope を破棄して再送するようにした (#179)
- EventRecorder の生成順を是正し、起動時のワンショット信号の欠落を解消した (#181)
- IndexedDB 保存の毎回フルスキャンを解消し、閉じたタブのゴーストを削除するようにした (#174)
- 検証 (Web) のスクリーンショット検証を shared に一元化し、CLI と status 軸を合流させた (#176)
- 一括投入検出の誤検知・検出漏れを修正した (エディタ整形由来の構造的編集の除外、単一行補完の扱い、複数行投入と `insertParagraph` の検出) (#116, #118, #169, #171)
- verify-cli が未知フラグや値欠落を usage error (exit 1) として拒否するようにした (#164)
- 検証 (Web) のハードコード日本語を `t()` 化し、en ロケールでの言語混在を解消した (#184)

### セキュリティ

- 署名チェックポイントの公開鍵をレジストリ登録済みのものだけ信頼するよう厳格化した (レビュー指摘 Critical 1 + High 6 の修正を含む) (#98)
- editor / verify の `innerHTML` 挿入経路に残っていた XSS を修正した (タブのファイル名、ResultPanel / StatusBarUI) (#160, #161)
- 検証 (Web) の ZIP 展開に zip 爆弾ガードを適用した (#162)
- 試験バンドルの v1 へのダウングレード偽造を拒否するようにした (#163)
- 内部ペーストの許可を、マーカーの自己申告ではなくチェーンの replay 検証に基づく判定へ変更した (#173)
- `--require-root-anchor` の試験モード免除を、検証済みの束縛がある場合のみに限定した (#170)
- `/api/checkpoint/sign` を `sessionStartToken` 前提にし、KV write 増幅による DoS を塞いだ ([ADR-0027](docs/adr/0027-checkpoint-sign-requires-session-token.md)) (#183)
- replay と乖離した `contentSnapshot` を外部入力相当として advisory 検出するようにした (#182)
- Workers の dev 用 Worker 名を分離し、未捕捉例外の最終防衛を追加した (#165)

[Unreleased]: https://github.com/shinyaoguri/typedcode/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/shinyaoguri/typedcode/releases/tag/v1.1.0
