# Changelog

このファイルは TypedCode の主要な変更を記録します。

書式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠し、
バージョニングは [Semantic Versioning](https://semver.org/lang/ja/) に従います。

リリースは `v*` タグの push で production へ配信されます (タグ式 GitHub Flow、[ADR-0028](docs/adr/0028-tag-based-github-flow.md))。

## [Unreleased]

### 追加

- 記録側 PoSW のベンチ `npm run bench:posw -w @typedcode/e2e` を足した。実エディタで打鍵とマウス移動を一定のペースで流し、PoSW の処理待ち (backlog) と掃ける速さを、1 倍と CPU 4 倍相当 (メインスレッドは CDP、Worker は処理時間の引き延ばしで模擬) で測る。この測定から、PoSW の反復数を 10,000 から 1,000 に下げると決めた (CPU 4 倍相当では 2 文字/秒の打鍵でも backlog が増え続けた。実装は #611。ADR-0045、#241)
- verify-cli に `--aggregate-bundle <out.json>` を足した。集計・研究用の派生バンドル (ADR-0024 Tier S、`aggregate-bundle/1`) で、`--analysis-bundle` (Tier A) から数値とカテゴリだけを allowlist で書き出す。ファイル名・振り返りノート (`reflectionNotes`)・分析器の `summary` / `summaryParams` / `evidence`・`analyzerId`・event index と、型に無い余分なフィールドは出さない (外部分析器の独自の次元などの未知の列挙値は `other`)。コホート基準 (ADR-0025) の入力にもなる。`--analysis-bundle` / `--aggregate-bundle` の各要素に「派生ビューで単独では検証できない」旨の固定文言 `notice` を足した (Tier A はそれ以外変えていない)。README に 2 つの出力の対象読者と項目を書き、Tier A (ファイル名と自由記述を含む) を学外へ共有しないよう明記した。入力の proof / ZIP は書き換えない (#304)
- verify-cli に受理ポリシーのフラグ `--require-signed-checkpoints` (署名 cp が 1 件も無い proof を exit 1) と `--require-final-anchor` (最終イベントまで署名が届いていない proof を exit 1。未署名の末尾の件数を出す) を足した。既存の `--require-root-anchor` / `--require-anchor-density` を含め、違反は整合性の失敗と分けて `--- Acceptance policy ---` 節に `FAIL <code>: <理由>` で出し、`--analysis-json` の各要素に `policy` を足した。shared の `verifyProofFile` は `integrityValid` (ポリシー無しの結論) と `policy: { applied, evaluated, violations }` を返し、改ざんなどで検証が失敗した proof ではポリシーを評価しない。`--require-anchor-density` で密度が疎な proof は、これまでの `Anchoring: FAILED (density gate)` ではなく `Anchoring: VERIFIED` + 警告 + ポリシー違反になる (exit 1 は変わらない)。フラグ無しの結論と出力は変えていない。Web はポリシーを適用しない。`--require-final-anchor` は #236(b) の着地前は短時間の試験以外で常用しない (ADR-0043、#296)
- editor に救出ボタン (「コードを救出 (証明なし)」) を足した。左のダウンロードメニューと問題パネル (exam でも出る) から、保存先・認証・PoSW の排出のどれも待たずに、メモリ上の最新のコードと記録を `RESCUE_TC<ts>.zip` (`src/`・`logs/`・`rescue-manifest.json`) として出す。証明ではない (`*_proof.json` を入れず、manifest に `notAProof: true`)。1 タブの読み出しが失敗しても他のタブは出し、ZIP が作れなければ単一 JSON、それも保存できなければソースを 1 つずつ出す。形式は system-spec §5.4、判断は ADR-0042 (#544)
- verify-cli に `--extract-sources <dir>` を足した。ZIP 入力の proof ごとに `<dir>/<proof のベース名>/` へ、`submitted.<ext>` (同梱ソースの原文バイト)・`verified.<ext>` (`proof.content`。チェーンが検証に通ったときだけ)・`report.json` (照合の状態と検証結果の要約) を書く。不一致や検証失敗でも submitted は書き、exit code は変えない。入力の ZIP と書き出し先の既存ファイルは上書きせず (既存のディレクトリはエラーで exit 1)、`<dir>` の外には書かない (ZIP エントリ名と `proof.filename` から作る名前は無害化する)。採点者が jq で JSON から本文を抜かずに済む (#409)
- verify (Web) で、検証中・待機中の proof を結果パネルのキャンセルボタンで 1 件ずつ止められるようにした。止めた proof は `data-status="cancelled"` (未検証。error ではないので中立色) になり、残りの検証は続く。開くと再検証ボタンが出る。検証キューはイベント数の少ない順に処理し (重い proof の後ろで軽い proof の結果が待たされない)、サイドバーでファイルやフォルダを消すとキューからも外し、完了した proof の写しをキューに残さない。ステータスバーの集約は `data-proof-cancelled` でキャンセル件数を別に数える。verify-cli の README に、複数の提出物を `xargs -P` で並列に検証する例を足した (#331)
- テンプレート (`templateInjection`) で入った文字数と打った文字数を、分析層の advisory signal (severity `info`) として出すようにした。verify の分析カードと verify-cli の `--- Analysis (advisory) ---` に「テンプレートで入った文字数 500 / 打った文字数 10」の形で出る。文字数は自己申告の `contentLength` ではなく `data.content.length` の合計で数える。`reviewPriority` と著述性の `notableSignals`、検証結果、`isPureTyping` は変えない (#416)

### 変更

- export の README で、PoSW を「生成に時間がかかる計算証明」「計算コストが膨大」「タイムスタンプの偽造は PoSW のタイミングと矛盾」と説明していたのをやめ、各イベントに課す逐次のハッシュ計算で、作業時間や打鍵時刻の証明ではないと書いた。時刻の照合は署名済みチェックポイントのサーバー時刻で行うと書いた。system-spec §4.4 からも「最低限の計算時間を強制」「最低 50 秒」を消した (ADR-0045、#241)
- editor が証明ファイルに入れる端末情報 (fingerprint) から、canvas の描画結果とインストール済みフォントの一覧を外し、WebGL は GPU のベンダー名とレンダラー名 (unmasked の 2 値) だけにした。どちらも読むコードが無く、チェーン root・流用検出・セッション開始トークンの端末束縛は hash の等値比較で足りる。ヘッドレス GPU の検出 (分析層) は変わらない。利用規約の「ブラウザフィンガープリント」に、集める 13 項目を列挙した。検証器と proof 形式は変えておらず、canvas や fonts を含む旧い proof もそのまま検証できる。同じ端末でもこの変更の前後で fingerprint のハッシュは変わる。キーごとの理由は ADR-0044 (#242)
- editor のタブ作成 (casual の既定タブ・新規ファイル・タブの追加) で、Turnstile と session/start の認証を 15 秒 (`TAB_CREATE_VERIFICATION_BUDGET_MS`。export 前の予算と同じ値) で打ち切るようにした。これまでは Turnstile の配信元や Workers に届かない網で、認証を諦めるまで (33 秒〜3 分) 編集を始められなかった。予算を過ぎたら表示中のチャレンジも閉じ、`#0` に失敗の attestation (`failureReason: "timeout"`) を記録して、root を時刻アンカーしない proof (`rootAnchored: false`) で開始する。予算を過ぎてから session/start の token が届いたら、root には使わず、そのセッションのチェックポイントの署名に使う (それまで署名を待っていたものも送る)。casual の export 前認証は従来どおり予算なしで待つ。proof の形式は変えていない (#375)
- 分析器が例外を投げた・期限 (分析器ごとに 10 秒) までに返らなかった・契約に合わない出力を返した場合を、「分析シグナルなし」と区別して表示するようにした。verify-cli は `--- Analysis (advisory) ---` に `Analysis unavailable: boom (failed), hang (timeout)` の行を出し、`No analysis signals.` は全分析器が正常に終わって 0 件のときだけ出す。verify (Web) の分析カードは、どの分析器も結果を返せなければバッジを「分析不能」(warning) にし、一部だけなら注記を出して、分析器の一覧に状態とメッセージを出す。どの分析器も正常に終わらなかったときは、三層保証の著述性に signal 数と要確認度 (`review 0%`) を出さない。`--analysis-json` / `--analysis-bundle` の `analysis` に `analyzerStatus` (分析器ごとの `ok` / `failed` / `timeout` / `invalid-output`、`message`、`discardedSignals`) が増える (`analyzerVersions` は残し、schema は `analysis-bundle/1` のまま)。解決しない Promise を返す `--analyzer` でも、期限の後に検証結果を最後まで出して exit code を返す (これまでは `Loading proof file...` で止まっていた)。未知の severity や有限でない score を返す signal は捨て、要確認度を NaN や 100% にしない。検証結果 (`valid` / exit code / integrity) は変えていない。期限は非同期の待ちにしか効かず、同期の無限ループは止まらない (外部分析器は信頼済みのコードとして扱う) (#301)
- dev 用の公開鍵置き場 `packages/shared/src/checkpointKeys/localKeys.ts` と `packages/shared/src/examAuthorityKeys/localKeys.ts` を git の追跡から外して gitignore した。無ければ `npm install` / `npm ci` (ルートの postinstall)・e2e の setup・`npm run doctor` が隣の `localKeys.ts.example` から作る (既存のファイルは上書きしない)。これまでは空配列のファイルを追跡して各自が skip-worktree で隠す運用で、worktree では効かず、e2e の setup が書いた鍵が誤コミットされると本番の verifier が dev 鍵を信頼する経路が残っていた。e2e の setup の後も `git status` は clean のまま。**移行**: skip-worktree で自分の鍵を置いている人は pull の前に、ファイルを退避 → `git update-index --no-skip-worktree <path>` → `git checkout -- <path>` → pull → 退避したファイルを戻す (退避しないと pull が `would be overwritten` で止まる)。鍵を置いていない人は pull 後に `npm install` (または `npm run doctor`) で作られる (#338)
- export 前の Turnstile 認証の記録 (`preExportAttestation`) に HMAC 署名を付けるのをやめ、Worker の secret `ATTESTATION_SECRET_KEY` を不要にした。署名を検証する場所は #340 以降どこにも無く、セッションにも内容にも束縛されていなかった。Turnstile の検証は続け、`/api/verify-captcha` は成功時に同じ形の attestation を `signature: "unsigned"` で返す (開いたままの旧い editor も export できる)。editor は成功を `success` だけで判定し、記録する `signature` をサーバの値にかかわらず `"unsigned"` にそろえる。proof の形式と検証結果は変えていない (旧い proof の HMAC の `signature` は読むが検証しない)。staging / production の `[secrets] required` からも外した。**運用者向け**: マージ後、deploy-staging が新しい `[secrets] required` で通ってから `npx wrangler secret delete ATTESTATION_SECRET_KEY --config wrangler.staging.toml` を、production は次の `v*` タグの deploy が通ってから `--config wrangler.production.toml` で同様に消す (先に消すと、旧い宣言のままの deploy が secret 不足で落ちる)。残っていても無害 (#415)
- editor の TypeScript 実行で、JavaScript への transpile を同梱の TypeScript コンパイラ (`ts.transpileModule`) から Monaco 同梱の TypeScript worker (`getEmitOutput`) に移し、全ページが読み込んでいたコンパイラ (約 3.6 MB) をバンドルから外した。型チェックはしないのも、構文エラーの出力 (`(行,列): error TS<code>: <message>`) とマーカーも従来どおり。compilerOptions は Monaco の既定 (target ESNext) になり、top-level await はそのまま実行される (#605)
- 全 workspace の型チェックを TypeScript 7 (ネイティブコンパイラ) に上げた (`typescript` を `^7.0.2` に)。鮮度チェック (`scripts/summarize-outdated.mjs`) の typescript 7 の据え置きを外し、次の版からは他の依存と同じく報告される (#208)

### 修正

- 時刻アンカーの post-hoc (事後一括署名) の疑いを、自己申告の `clientTimestamp` ではなく、ハッシュで束縛されたイベント時刻 (`event.timestamp`) とサーバ時刻 (`serverTimestamp`) の照合で判定するようにした。任意の 2 つの署名チェックポイント (root がサーバアンカー済みなら開始トークンの `issuedAt` も含む) の間で、イベント時刻の進みがサーバ時刻の進みを `max(60 秒, 1%)` より超えたら疑う。これまでは `clientTimestamp` を署名時刻どおりに名乗るだけで、オフラインで合成して後からまとめて署名させた proof が `temporal: anchored` になった。アンカー密度の「疎」は、サーバ時刻の空白のうちイベント時刻で説明できない分と、署名で挟まれていないイベントの時刻の幅で見るようにし、考え込んで長く手を止めただけの正直なセッションが `partial` にならないようにした。通信断の後に溜まったチェックポイントが 60 秒を超えて遅れて署名された正直な proof は、`anchored` から `partial` に下がる (整合性と内容は変わらない)。verify-cli の Anchoring 行と verify (Web) の時刻アンカーカードに、イベント時刻の最大先行と幅を出す。`valid` / exit code と proof フォーマットは変えていない (#320)
- editor の起動処理が失敗すると、エラー表示も無くスピナーが回り続けていた問題を直した。IndexedDB を開けないなど起動のどこで失敗しても、再読み込みを案内するエラー画面 (`data-dialog="boot-failure"`。データを消す操作は置かない) を出す。あわせて保存先の接続の 3 つの事象を扱うようにした: 別のタブの古い接続が閉じず open が `blocked` になったら待ち続けずに起動失敗にして「他の TypedCode のタブを閉じてから再読み込み」を案内する / 新しいバージョンのページが DB を開こうとした (`versionchange`) ら接続を閉じて再読み込みを促す / サイトデータの削除などで接続が強制的に閉じられた (`close`) ら 1 回だけ開き直し、開き直せなければ再読み込みと救出を促す。接続を失った後の保存は失敗として返り、同期状態は `degraded` (sessionStorage も失敗なら `failed`) になる (#325)
- editor で現在のタブを export すると、ステータスバーのイベント数とハッシュ (`#event-count[data-count]` / `#current-hash[data-hash]`) が、export 前の認証 (`preExportAttestation`) の 1 件ぶん遅れたまま、全イベントを検証し直す間 (件数が多いと数十秒) 残っていた問題を直した。EventRecorder を通さず proof に直接記録する経路でも、PoSW の確定のたびに表示を追従させる (`TabManager.setOnProofChange`)。proof の形式と記録内容は変えていない (#521)
- editor で現在のタブを export した後、ダウンロード後の自己検証 (全イベントの PoSW の再計算。件数が多いと数十秒) が終わるまで、次の export (現在のタブ・全タブとも) を何も出さずに無視していた問題を直した。export の単一フライトのガードはダウンロードまでの区間だけを閉じ、自己検証と結果の通知はその外で行う。自己検証が例外で終わったときは、ZIP は出ているので「export に失敗」ではなく「検証に失敗」と知らせる (#565)
- editor で、同じモードで開いているページから `window.open` で開いた同じモードのページが、二重起動の検出 (`SingleInstanceGuard`) をすり抜けて復旧ダイアログで止まっていた問題を直した。popup は開いた側と同じ main thread で動くので、popup の初期化の間は開いた側が問い合わせ (ping) に答えられず、500ms の待ちが先に切れていた。判定を Web Locks (`navigator.locks`。モードごとのロック) に移し、後から開いた側は時間に関係なく「別のタブで起動中」で止まる。`navigator.locks` の無い環境では従来の ping → pong に戻る (#494)
- editor で、PoSW の処理待ちが残ったまま閉じて (またはリロードして) 再開すると、証明に載らなかった編集をエディタから外したうえで、元のコードをどこにも残さずに捨てていた問題を直した。エディタはこれまでどおり証明の版にする (そのまま export して検証が通る) が、元のコードは IndexedDB の新しいストア `unprovenContents` に追記のみで残し、その後の保存・リロード・タブを閉じる操作・復旧ダイアログの「新規セッション」でも上書き・削除しない。再開すると通知 (「元のコード X 文字 → 証明 Y 文字」) を出し、差分 (読み取り専用) と元のコード (`UNPROVEN_<source>`) のダウンロードを開ける。救出 ZIP には `src/` とは別の `unproven/<n>/<source>` に入り、manifest のタブに `unprovenContents` (パスと文字数) を足した (schema を `typedcode-rescue/2` に上げた)。session DB のバージョンは 2 → 3 (ストアを足すだけで既存のデータは変えない)。proof の形式と検証器は変えていない。形式は system-spec §5.4.1、判断は ADR-0042 の段階 2 (#413)
- セッション開始トークンを検証できない proof が「改ざん」と表示されていた問題を直した。token の keyId が検証器の鍵 registry に無い (古い verify-cli / verify で新しい鍵の token を見る)・署名が壊れている・別の端末向けに発行されている、のどれでも `Metadata: FAIL` / `Integrity: FAILED` になっていた。チェーン根が token の serverNonce 込みの式で自己整合していれば、内容の改ざんではないので整合性 (integrity) は落とさず、開始時刻の根拠が無い (`rootAnchored: false`) として扱う。総合は不合格のまま (exit 1) で、理由は「改ざんではない」と読める文言と keyId (registry に無いときは「registry が古い可能性」も) で出す。verify-cli の `Root anchor:` 行は `no session start token` ではなく `UNTRUSTED` と理由を出し、verify (Web) は信頼バッジに時刻アンカーの error を出す (未アンカーの警告は重ねない)。時刻アンカーは、有効な署名チェックポイントがあれば `partial`、無ければ `unanchored`。serverNonce を書き換えてチェーン根が合わなくなった proof は従来どおり改ざんとして落とす。proof フォーマットは変えていない (#329)
- 手元の e2e が、同じポートを握っている別の worktree の editor / workers / verify に黙ってつながり、向こうの鍵で署名された証明を `Unknown keyId` で落としていた問題を直した。dev サーバが作業ツリーの識別子を名乗るようにし (editor / verify は応答ヘッダ `X-TypedCode-Worktree`、workers は `wrangler dev --var DEV_WORKTREE_ID` を受けて `/health` の `worktree`)、e2e の globalSetup がテストより前に照合する。別の識別子・識別子なし・応答なしなら、テストを 1 本も走らせずに「ポート N は別の作業ツリーのサーバが使用中 (相手: <パス>)」の形で落ちる。同じ作業ツリーのサーバは従来どおり再利用し、CI でサーバを起こす手順は変えていない。staging / production の `/health` の応答も変えていない (#552)
- 本番ビルドのスモーク (`npm run test:build -w @typedcode/e2e`) も、再利用する workers を照合せず、別の worktree の workers に黙ってつながっていた問題を直した。dev 設定と同じ照合を workers 1 台に掛け、別の作業ツリーのサーバならテストを走らせずに落ちる (再実行例は `test:build`)。あわせて、`E2E_WORKERS_PORT` を変えても wrangler が 8787 に上がり、ビルドした editor も `.env` の API の向き先を叩いていたのを、どちらもそのポートに揃えた。CI で起こすサーバと再利用の有無は変えていない (#560)
- editor で、保存の書き込みが続いている最中に設定メニューのリセットを確定すると、リセットが失敗の通知を出してリロードされないことがあった問題を直した。自分の DB 接続を閉じても、その接続のトランザクションが終わるまでは閉じきらず、Chromium は削除に一時的な `blocked` を出す。これを即失敗にしていた。`blocked` を受けてから猶予 (`DELETE_BLOCKED_GRACE_MS`) の間は削除の完了を待ち、過ぎても閉じない接続 (別タブなど) が握っているときだけ失敗にする (#524)
- editor の同期状態が、IndexedDB や sessionStorage への保存に失敗しても `Synced` (同期済み) と表示していた問題を直した。保存の結果で状態を決め、片方にだけ保存できたら `degraded` (一部のみ保存)、どちらにも保存できなかったら `failed` (保存失敗) を出し、2 秒から倍々 (上限 60 秒) の間隔で再試行して、書けるようになったら `synced` に戻す。IndexedDB の書き込みは transaction の commit (`oncomplete`) で成功とし、abort (`onabort`) でも失敗にするので、commit の時点で abort されても保存と export がハングしない。export 前の保存が失敗しても、警告を残して export (proof はメモリ上のチェーンから作る) を続ける (#543)
- 三層保証の時刻アンカーが、最後の署名チェックポイントが最終イベントまで届いていない proof でも `anchored` になっていた問題を直した。root がサーバアンカー済みで先頭 1 イベントだけ署名した proof (残りはオフラインで書き足せる) が、短いセッションでは密度も疎にならず `valid: true` / `temporal: anchored` だった。セッション開始トークンと署名チェックポイントの sessionId が食い違う proof も `anchored` だった。どちらも `partial` (root も無ければ `unanchored`) にする。verify-cli の Anchoring 行に最後に署名されたイベントの位置と未署名の末尾の件数 (`! K trailing events are not covered by a signed checkpoint (unsigned tail)`) を、verify (Web) の時刻アンカーカードにも同じ情報を出す。`valid` / exit code・整合性 (integrity)・proof フォーマットは変えていない (#295)
- editor の JavaScript / TypeScript の実行を、opaque origin の sandbox iframe (`sandbox="allow-scripts"`) の中の Worker に移した。これまでは同じ realm で動いていたため、停止してもタイマーの続きが出力・副作用を出して `success` で記録され、`for(;;){}` でエディタごと固まり、実行コードから親 DOM・localStorage・proof の IndexedDB・`/author` の秘密鍵の入力欄に届いた。停止・30 秒のタイムアウト・出力予算 (stdout + stderr の合計 1,000,000 文字) の超過は、実行環境ごと除去して終わらせる。runner の CSP は `connect-src 'none'` で、実行コードからネットワークへ出られない。完了の定義は Node と同じで、張ったタイマーが残っている間は終わらない (止めない `setInterval` はタイムアウト)。実行の結果 (`codeExecution` の result の outcome) に `timeout` を足し、`summarizeProcess` は失敗に数える。停止してすぐ再実行すると、古い run の出力が新しい run のターミナルに混ざり、新しい run を停止できなくなっていた競合も直した (#290)
- JS の実行時エラーの行番号が 2 行ずれていたのと、エディタにエラーのマーカーが付いていなかったのを直した。ターミナルの `(at line N, column M)` はエラーを投げた行を指し、その行にマーカーが付く (#290)
- editor で `recordToAllTabs` / `recordSessionSnapshotTo` (windowResize・visibility / focus・スクリーンショット系・fullscreen・sessionResumed・起動時ワンショットの流し直しなど) が記録したイベントも、`record()` と同じく確定ごとに IndexedDB へ 1 件ずつ append するようにした。これまでは TabManager のデバウンス保存だけが頼りで、直後に打鍵が続くと後続の seq だけが先に入って events に欠番ができ、そのまま落ちると復元したチェーンが欠番で切れた。この append もタブを閉じる後始末 (確定 → append → 削除) の待ち対象に入る (#471)
- ja の設定メニューで `settings.verifyProof` と `settings.toggleTheme` が英語 (「Verify Proof」「Toggle Theme」) のままだったのを、「証明を検証」「テーマを切り替え」に訳した。en は変えていない (#518)
- verify-cli が、ZIP に同梱されたソースが `proof.content` と違っても `Verification PASSED` / exit 0 にしていた問題を直した。proof ごとに、同梱ソースを proof の `filename` と `language` から editor と同じ手順で作った期待名で対にして、バイト単位で照合する (改行・BOM は正規化しない)。不一致と、対応を一意に決められない場合は exit 1、ソース欠落と孤立ソースは警告で exit code に影響しない。`Integrity: PROVEN` は変わらず、結果は `--- Submission ---` 節に出る。verify (Web) も同じ shared の関数で突き合わせ、不一致のタブを error にする。これまで Web は proof 名の `_proof.json` を剥がしたベース名で引いていたので、同名のタブの 2 つ目 (`main_proof_1.json` ↔ `main_1.c`) は黙って未照合だった。言語 → 拡張子の表と export のファイル名の付け方は shared へ移し、editor の export もそれを使う。`--extract-sources` は #409 (#293)

## [1.2.0] - 2026-11-03

### 追加

- 検証の部品関数の照合 6 箇所を、関数を直接呼んで確かめるテストを足した (`verification.components.test.ts`)。`verifyInitialHashRoot` の deviceId と fingerprint components、`verifyFinalChainHash` の `typingProofData.finalEventChainHash`、`verifyCheckpoints` の cp の順序・timestamp・contentHash について、条件を外すと赤くなる。仕様と実装は変えていない (#500)
- ZIP の予算付きリーダー (`readZipEntryBytes`) と空エントリ判定 (`isJszipEmptyEntry`) を守るテストを足した。予算超過時の `pause()`・stream の `error` での reject・複数チャンクの連結を、`isJszipEmptyEntry` の 5 条件それぞれを緩めると赤になる入力とあわせて固定し、`packages/shared/AGENTS.md` の不変条件 9 (形の判定を緩めると `zipBudget.test.ts` が止める) を実測と一致させた (#501)
- root アンカーの照合 (`First event does not start from the declared initial chain hash`) と full モードの PoSW 検証 (`PoSW verification failed at event <i>`) の拒否の分岐を通るテストを shared に足した。変異検査で、どちらの判定を外しても既存テストが緑のままだった (#467 の系統 1・2)。仕様・実装は変えていない (#496)
- 試験 (exam) モードの round-trip E2E を足した (`packages/e2e/tests/exam-roundtrip.spec.ts`)。誤コードはゲートに留まり、正コードで解錠 → 打鍵 → export した ZIP を `verify-cli --mode fast --exam-package` に通すと exit 0 と束縛 (Root binding / Signature / Package hash / Content hash) の PASS 行が出る。別の問題パッケージと本物の registry では exit 1。fixture は `npm run setup` が `make-exam-package.mjs` で生成し、shared の追跡ファイル `examAuthorityKeys/localKeys.ts` は書き換えず、E2E の実行時だけ出題者鍵を差し替える (#229)
- 検証 (Web) で複数 proof を読み込んだとき、全件の検証が終わったあともステータスバーに `N/M proofs passed` と失敗件数を残すようにした (警告は passed に数える。plaintext・画像は数えず、読めない `*_proof.json` は失敗に数える)。失敗があれば押して最初に失敗した proof を開ける。状態契約に `#queue-status[data-proof-total/passed/failed]` を追加 (#282)
- `verifyProofFile` のセッション開始トークンの sessionId 照合 (別セッションのトークン流用を弾く。ADR-0017) と、署名 cp が無効なら全体を無効にする判定 (ADR-0020) を shared のテストで守るようにした (`verification.sessionToken.test.ts`)。これまでは verify の `webCliParity.test.ts` でしか捕まらなかった。仕様・実装の変更なし (#499, 親 #467)
- 変異検査 (#467) の系統 3・4 を守るテストを shared に足した (`verification.metadata.test.ts`、仕様・実装の変更なし)。`verifyProofFile` の `metadataValid` は `typingProofHash` の不一致と root の不一致のどちらか片方だけでも落ち、申告メタデータ (`pasteEvents` など 6 キーと `totalTypingTime`) を偽って `typingProofHash` を再計算した proof は拒否される。貼り付け・ドロップ・削除を含む正規 proof は `valid: true` のまま (#498)
- 検証の「厳しくする向き」の変異検査 (#467) で生き残った 3 箇所について、正規の proof が通ることを確かめる正の対照テストを足した (`verification.positiveControls.test.ts`)。timestamp が同値で連続するチェーン、置換・削除 (`rangeLength > 0`) を含む replay、templateInjection / contentSnapshot の後に contentChange が続く replay が `valid: true` になる。仕様の変更なし (#502)
- editor の UI 状態を `data-*` の状態契約として DOM に出した。タブ (`.editor-tab` の `data-active` / `data-filename` / `data-language` / `data-verification`)、ステータスバー (`#sync-status-item[data-state]` / `#event-count[data-count]` / `#current-hash[data-hash]`)、アプリの段階 (`html[data-app-state]`)、ダイアログの root (`data-dialog`) が対象で、表は `packages/editor/AGENTS.md` の「状態契約」節にある。dev ビルドだけで内部状態を返す `window.__tcTestSnapshot()` を足し (本番ビルドで `undefined` になることを `production-build.spec` が見張る)、E2E の判定を契約に切り替えて、DOM と内部状態の一致を確かめる `expectConsistent()` を足した (#433)
- 検証 (Web) の判定を `data-*` の状態契約として DOM に出した。`#assurance-strip` と `.assurance-chip` に三層判定の生の値、`#result-status-icon[data-level]`、ファイル一覧とタブに `data-status` / `data-filename` を付け、判定が無いときは属性を外す。あわせて `#file-input` を `multiple` にして change の二重購読を 1 か所にまとめ、`?mode=fast|audit|full` で検証モードの初期値を上書きできるようにした (既定は full のまま) (#215)

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
- C / C++ の実行に使う `@wasmer/sdk` を 0.10 から 0.19 に上げ、`CExecutor` を新しい API (`Wasmer` クライアント、実行ごとの sandbox、`Process.kill()` による停止) に合わせた。本番ビルドで SDK の worker が起動しない問題は Vite プラグイン (`wasmerSdkBundledWorkers`) で塞ぎ、ネットワーク専用の AGPL-3.0 の推移的依存 `@mercuryworkshop/wisp-js` はスタブに差し替えて配信物から外した。実行結果の形とエラー分類は変えていない (#364)
- 誰も読まない永続の端末 ID (`typedcode-device-id`) の収集をやめ、既存の端末に残った値は起動時に 1 回消すようにした。あわせて利用規約の「サーバーへの自動送信は一切行いません」を、実際に送るもの (セッション ID・fingerprint のハッシュ・ハッシュチェーンの値と時刻) の説明に改めた (#412)

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
- export ZIP の README (ja / en) のプライバシー注記が「サーバーへの自動アップロードなし」と書き、実際の送信内容 (時刻証明・人間確認) と利用規約の双方に食い違っていた問題を修正した。コード・打鍵内容・個人情報は送らず、送るのは Turnstile トークンと、セッション ID・fingerprint のハッシュ・ハッシュチェーンの値と時刻だけ、と規約と同じ事実に揃えた (#470)
- 記録のあるタブがあるとき、モードの移動 (ModeSwitcher) と表示言語の切替で離脱確認が出て、キャンセルすると `html[lang]` だけが変わった中途半端な状態が残る問題を修正した。作業が失われない遷移なので確認 (`preventDefault`) だけを抑止し、sessionStorage への同期保存とリロード検出はそのまま走らせる (#445)
- class の問題・テンプレート・exam の問題から作ったタブの名前が `p1.c.c` のように拡張子を二重に付けていた問題を修正した。表示名は、既にその言語の拡張子で終わっていれば足さない (export と同じ規則) (#441)
- タブを閉じても PoSW Worker が終了せず、計算中のイベントが tabs 行の削除より後に append されて、どのタブにも属さない events 行が IndexedDB に残る問題を修正した。閉じたタブは「キューの排出 → 計算中のイベントの確定と append → tabs 行と events 行の削除 → Worker の終了」の順で片付ける (#342)
- export の後、ステータスバーのイベント数とハッシュ (`#event-count` / `#current-hash`) が、export で proof に足した reflectionNote / preExportAttestation を反映せず古いまま残る問題を修正した。export の試行が終わるたびに表示を更新する (#439)
- 検証 (Web) の About ダイアログを閉じるボタンや overlay のクリックで閉じると Escape の keydown リスナーが残り、開閉のたびに溜まる問題を修正した。どの経路で閉じてもリスナーを外す (#408)
- 検証 (Web) で結果を表示すると (1280x800 など) チャート欄が潰れ、タイムラインなどのチャートタブが結果カードに覆われて押せない問題を修正した。左パネルの子を縮ませず、溢れた分はパネルのスクロールに回す。状態契約に `.chart-tab` / `.chart-panel` の `data-active` を追加 (#395)
- 検証 (Web) で最後のタブを閉じた後もサイドバーとタブ管理の active が閉じたファイルを指したまま残る問題と、入れ子のフォルダを削除しても子孫のファイルのタブが残る問題を修正した (#387)
- 署名 API (`/api/checkpoint/sign`) が署名する `serverTimestamp` を `max(現在時刻, 前回値 + 1ms)` にクランプし、Workers 間のクロックスキューで時刻が逆行して正直な proof が検証で落ちる問題を塞いだ。KV の読み書きは増えない。KV の結果整合で残る窓 (検証器側の許容) は #226 の後続で扱う (#402)
- リロードをまたいだタブ切り替え履歴 (`tab-switches.json`) の復元が、ロードごとに 0 起点の timestamp で並べられ、リロード後の切替がリロード前より前に並びうる問題を修正した。IndexedDB の追記順 (autoIncrement の `id`) で並べる。proof の形と timestamp の意味は変えない (#385)
- E2E ヘルパ `openModeFresh(mode, { screenShare: 'optOut' })` が画面共有オプトアウトの確認ダイアログで止まり、起動待ちまで進まなかった問題を修正した (#374)
- `npm run setup -w @typedcode/e2e` が、既存の `.dev.vars` の署名 keyId が `registry.ts` / `localKeys.ts` のどちらにも無いとき、keyId と直し方を出して exit 1 で止まるようにした。これまでは何もせず終わり、E2E が「署名付きチェックポイントが 0 件」という原因から遠い所で落ちていた (#388)
- verify-cli の 3 件を修正した。`--analyzer` で渡した外部分析器が検証結果のオブジェクトを書き換えて改ざん proof を exit 0 にできた構造を塞いだ (結果を凍結してから分析層へ渡し、判定に効く値を分析より前に確定させる。[ADR-0009](docs/adr/0009-pluggable-analysis-layer.md) / [ADR-0023](docs/adr/0023-analysis-platform-not-judge.md))。`process.exit()` をやめて `process.exitCode` にし、パイプ (`| tee` など) で stdout の末尾が切れる問題を直した。`audit` モードの help を実装 (full と同等) に揃えた (#283)
- export 時に proof へ書く自己申告の `isPureTyping` が採点側と別の式で計算され、括弧の自動補完を 1 回使うだけで false になって採点側の判定と食い違う値が proof に焼かれていた問題を修正した。判定を `evaluatePureTyping` に一本化し、採点側と editor が同じ関数を呼ぶ。あわせて `VALID_EVENT_TYPES` を `EventType` の型から導出し、手書きの Set から漏れていた 3 種 (`environmentProbe` / `fullscreenChange` / `examOpened`) を埋めた (以後、型に足すと tsc が記入漏れを検出する) (#222, #235)
- verify-cli が、スクリーンショットの改ざんだけで失敗した proof に `Error: All hashes verified successfully` という成功メッセージを失敗理由として出していた問題を修正した (`Screenshots failed: ...` を出す)。analysis bundle の `integrityValid` が gate 込みの `valid` になっていて、`--require-root-anchor` で落ちただけの proof が同じレコードの `assurance.integrity: 'proven'` と矛盾していたのを、整合性の判定 (`integrity !== 'failed'`) に揃えた ([ADR-0024](docs/adr/0024-data-minimization-tiers.md))。exit code は変わらない (#217, #219)
- 本番ビルド (Cloudflare Pages / `vite preview`) でエディタが一切起動しない問題を修正した。monaco 0.56 のチャンク構成の変更で、`vite-plugin-top-level-await` の変換が関数宣言の巻き上げを壊していたため、プラグインを外した (#255)
- E2E が verify-cli を起動するときの tsx の解決を、root の `node_modules/.bin/tsx` 決め打ちから `require.resolve('tsx/cli')` に変え、npm が tsx を入れ子に置いても動くようにした (#191)
- `npm run doctor -- --maintainer` が repo secret の `CLOUDFLARE_API_TOKEN` を必須にしていた問題を修正した。docs/setup.md の方針どおり staging / production の Environment secret として検査し、repo level に残っていれば警告する (#190)

### セキュリティ

- HTML プレビュー iframe を `sandbox="allow-scripts allow-modals allow-forms"` の opaque origin で隔離し、プレビュー内のスクリプトから親画面・localStorage・IndexedDB (proof の保存先)・トップレベル遷移・ポップアップに届かないようにした。内容の投入は srcdoc に一本化し、スクロール位置の保存/復帰は postMessage 経由になった (#291)
- 公開鍵レジストリの `validFrom` / `validUntil` / `revokedAt` が parse 不能な日時 (手書き運用での typo) だと鍵の有効性検査そのものがスキップされ、失効させたはずの鍵が黙って信頼される問題を修正した。日時が読めないエントリはそのエントリだけ信頼しない (fail-closed) ようにし、判定を署名チェックポイント / セッション開始トークン / 出題者鍵の 3 消費者で共有する実装に一本化した。あわせて出荷されるレジストリの日時形式を検査するテストを追加し、typo を CI で止めるようにした (#233)
- proof の `mode` を allowlist で検証したうえでエスケープし、検証サイトのオリジンで任意 HTML が実行できる XSS を塞いだ (#245)
- proof の `events` 各要素の構造を検証し、null 要素を積んで `metadata.totalEvents` を水増しする偽造を塞いだ (#246)
- proof の events に own property の `__proto__` を足してもハッシュが変わらず `valid: true` のままになる (malleability) 問題を、構造検証で invalid にして塞いだ (入れ子・循環参照も走査する)。あわせて「proof.json は整形 (キー順の変更・再シリアライズ) をせずに渡す」を [docs/system-spec.md](docs/system-spec.md) §5.3 に明記し、`Typing proof hash does not match metadata` に整形が原因になりうる旨を添えた。proof 形式・`PROOF_FORMAT_VERSION` は変えない (#417)
- verify-cli のエラー出力 (`printError`) も `safe()` を通し、JSON の構文エラーや ZIP エントリ名に入った端末制御文字で、直前の FAIL 行を消したり偽の ✓ を描いたりできる穴を塞いだ (#339)
- verify-cli が proof / ZIP 由来の文字列を無加工で stdout に出し、改行と ANSI エスケープで Summary に偽の `✓` 行を作れた問題を修正した。制御文字を除いて 200 文字で切り詰める `safe()` を出力の境界で未信頼値の補間点すべてに通し、変化が起きたときは `(sanitized)` を付ける (#266)
- proof の自己申告の `language` を allowlist に落とし、生値を表示層へ渡さないようにした。検証 (Web) では `ts hidden` のような値がコードプレビューの class に入ってプレビューを消せ、verify-cli では `Language:` 行に生値が出ていた (#248)
- `--exam-package` を渡した採点で、exam ブロックの無い proof (`/casual` で作ったもの) が束縛検証を素通りして exit 0 になる問題を修正した。package が渡されたら exam ブロックの有無によらず束縛を検証し、無ければ `Exam binding failed: Proof has no exam block` で失敗 (exit 1) にする。verify (Web) も同じ判定にした ([ADR-0006](docs/adr/0006-exam-mode-sealed-problem-binding.md)) (#218)
- miniflare が exact で固定している開発用依存の `sharp` を override で 0.35.4 に上げ (GHSA-rgj7-g3m4-5g8c。本番の Worker には入らない)、dead になっていた `uuid` の override を外した (#307)
- wrangler / miniflare 経由の開発用依存 `undici` を override で 7.29.0 に上げ (GHSA-4cwx-7wf7-3272 ほか。本番の Worker には入らない)、Dependabot の security update が失敗し続けていたのを解消した。dead になっていた `rollup` の override を外した (#259)

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

[Unreleased]: https://github.com/shinyaoguri/typedcode/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/shinyaoguri/typedcode/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/shinyaoguri/typedcode/releases/tag/v1.1.0
