# Changelog

このファイルは TypedCode の主要な変更を記録します。

書式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠し、
バージョニングは [Semantic Versioning](https://semver.org/lang/ja/) に従います。

リリースは `v*` タグの push で production へ配信されます (タグ式 GitHub Flow、[ADR-0028](docs/adr/0028-tag-based-github-flow.md))。

## [Unreleased]

### 変更

- fast モードの検証で PoSW を再計算していないことを Web / CLI の双方で明示し、整合性 (integrity) を `proven` に上げず `partial` として扱うようにした ([ADR-0031](docs/adr/0031-integrity-partial-when-posw-skipped.md))。合否判定と proof フォーマットは変更なし (#253)
- `npm run dev` の開発サーバポートをセット単位で自動割当し、editor の `/verify` プロキシと `VITE_API_URL` を実際の割当ポートへ追従させた ([ADR-0030](docs/adr/0030-dev-port-autoswitch.md))。個別起動 (`dev:editor` など) は従来どおり固定ポート (#197)
- README 群を実装に合わせて刷新し、実在しない検証機能の記述 (overclaim) や古い API 契約を解消した (#249)
- 依存パッケージを更新した (dompurify、postcss、sharp、wrangler、shell-quote、concurrently、GitHub Actions ほか) (#199, #200, #201, #204, #205, #206, #209)

### 修正

- 記録キューの排出が完了しないまま export され、content とチェーンが食い違う (検証すると invalid になる) proof が生成される問題を修正した。排出待ちを進捗ベースにし、排出できなかった場合は export を中止して通知する (#250)
- 検証 (Web) がフォルダ読み込み時にスクリーンショットのチェーン裏付け検査を行わず、ZIP で開いた場合と結論が変わる問題を修正した。あわせて、チェーンに記録があるのに manifest に存在しないスクリーンショット (剥ぎ取り) を Web でも警告するようにし、「0 枚」と「未検査」を区別して表示する (#251)
- 検証 (Web) が `sessionStartToken` と署名チェックポイントの `sessionId` を突合しておらず、別セッションのトークンを流用した proof を「整合性: 証明済み」と表示していた問題を修正した。あわせて署名チェックポイントの不備をハッシュチェーンの失敗として誤って帰属していた表示も是正した (#252)
- 単一タブ export の事前認証を best-effort 化し、class / assignment モードで Turnstile が不達のときに提出用 ZIP を一切出力できなくなる問題を修正した (失敗 attestation はチェーンに記録される) (#244)

### セキュリティ

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
