# Changelog

このファイルは TypedCode の主要な変更を記録します。

書式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠し、
バージョニングは [Semantic Versioning](https://semver.org/lang/ja/) に従います。

リリースは `v*` タグの push で production へ配信されます (タグ式 GitHub Flow、[ADR-0028](docs/adr/0028-tag-based-github-flow.md))。

## [Unreleased]

### 追加

- 検証 (Web) で複数 proof を読み込んだとき、全件の検証が終わったあともステータスバーに `N/M proofs passed` と失敗件数を残すようにした (警告は passed に数える。plaintext・画像は数えず、読めない `*_proof.json` は失敗に数える)。失敗があれば押して最初に失敗した proof を開ける。状態契約に `#queue-status[data-proof-total/passed/failed]` を追加 (#282)

### 変更

- 見た目・動きの証跡 (静止画と可逆のアニメーション WebP) を撮る撮影専用の E2E spec (`@shots`) と `npm run shots -w @typedcode/e2e` を足し、editor / verify の見た目を変える PR は本文に before/after の画像を載せる規律を置いた ([ADR-0036](docs/adr/0036-visual-evidence-on-prs.md))。通常の E2E と CI のシャードからは外している (#391)
- fast モードの検証で PoSW を再計算していないことを Web / CLI の双方で明示し、整合性 (integrity) を `proven` に上げず `partial` として扱うようにした ([ADR-0031](docs/adr/0031-integrity-partial-when-posw-skipped.md))。合否判定と proof フォーマットは変更なし (#253)
- `npm run dev` の開発サーバポートをセット単位で自動割当し、editor の `/verify` プロキシと `VITE_API_URL` を実際の割当ポートへ追従させた ([ADR-0030](docs/adr/0030-dev-port-autoswitch.md))。個別起動 (`dev:editor` など) は従来どおり固定ポート (#197)
- README 群を実装に合わせて刷新し、実在しない検証機能の記述 (overclaim) や古い API 契約を解消した (#249)
- 依存パッケージを更新した (dompurify、postcss、sharp、wrangler、shell-quote、concurrently、GitHub Actions ほか) (#199, #200, #201, #204, #205, #206, #209)
- PoSW 検証 (full モード) の反復を同期 SHA-256 (`@noble/hashes`) に置き換え、1 反復ごとの `await crypto.subtle.digest` を廃止した。出力は同一で、Node (verify-cli) では約 19 倍高速 (#267)
- `make-exam-package.mjs` の既定 deadline を `2999-12-31T23:59:59.999Z` (オープン) に変更し、`--release` / `--deadline` の説明を ADR-0013 と `/author` に揃えた。既定のまま作ったパッケージで全提出が「窓外 (advisory)」と表示されるノイズを解消 (#271)
- 呼び出し元ゼロの dead API を削除した: `TabManager` の `exportSingleTab` / `exportAllTabs` / `reset` / `getActiveContent` / `getSessionService`、`SessionStorageService` の `pruneOldSessions` / `truncateEvents` / `updateTabContent` / `updateTabMetadata`、shared の `MultiFileExportedProof` / `MultiFileExportEntry` / `isMultiFileProof` / `AnyExportedProof`、`beforeunload` での legacy スクリーンショット DB 削除 (#284, #231)
- 拡張子 → 言語の判定を verify から shared の実装へ一本化した (挙動の変更なし) (#278)

### 修正

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
