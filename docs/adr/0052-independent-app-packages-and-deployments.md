# ADR-0052: author・editor・verify を同じリポジトリで独立してビルド・公開する

- **Status**: Accepted (方針決定済み、実装は #807・#808。#808 は #857〜#859 に分割。ADR-0011 の author/verify の同一 origin 配信と ADR-0028 のアプリ一括公開を実装時に置換。タグの付け方と production へ出す契機は [ADR-0055](0055-release-channels-and-calendar-versioning.md) に従う)
- **Date**: 2026-11-18
- **Deciders**: @shinyaoguri
- **PR / Commit**: #814 (#805 を閉じる文書 PR)

**要約**: モノレポと main 1 本を維持し、author・editor・verify のパッケージ、origin、成果物、公開・復旧を分ける。内部ライブラリは各アプリのビルドに取り込む。
**人が判断すること**: なし。メンテナが独立開発・独立公開を選択済み。外部設定・配信は本 ADR の作成では変更しない。

## Context

author は `packages/editor/author.html` を入口に editor の翻訳・実行器・ターミナル等を参照する。verify は既に独立パッケージだが、本番の Vite base は `/verify/` で、`deploy.yml` は editor と verify の成果物を一つの Pages 配信物にまとめる。この構成では author だけの機能公開にも editor のビルドと公開が結び付く。

メンテナは以下を決定した (#804)。

- リポジトリは一つのまま、author・verify をパッケージ・サブドメイン・デプロイまで分離する。
- 現時点で利用者はいないため、破壊的な仕様変更と根本的な再設計を許容する。
- 過去仕様のログは、対応する規則で検証・再生できるようにする (ADR-0053・0054)。

ADR-0011 のパス方式は配線の簡素さを優先した判断である。学生の `/class`・`/assignment`・`/exam` は同じ editor の入口として引き続きパスを使う。一方、出題者の鍵を扱う author と提出物を読む verify は独立したアプリとして運用する。

ADR-0051 / #792 系では author の教材フォルダ編集が進行中である。本判断は配置と公開の境界を変えるもので、教材の形式・機能要件を変更しない。#802 の「検証」は解答例を実行するケース検証であり、ADR-0054 の暗号証明検証 SDK とは別の責務である。

## Considered Options

| 案 | 利点 | 欠点 |
|---|---|---|
| 現状のパス・一括公開を維持 | 配信設定が少ない | 独立公開できず、author は editor の内部に依存する |
| 同一モノレポの独立パッケージ・別 origin・独立公開 | 一括の型検査と共通コードを保ち、アプリだけ更新できる | 配信先と URL・環境別設定が増える |
| リポジトリも分割 | 権限・リリースを完全に分けやすい | 共通仕様の修正が複数 PR と依存更新に分散する |

## Decision

同一モノレポの独立アプリを採用する。共通コードのソースを共有し、公開済みの成果物はアプリごとに固定する。独立公開のために、実行時に最新版の共有 JavaScript を読み込む仕組みは作らない。

### 1. パッケージ境界

| パッケージ | 責務・公開単位 |
|---|---|
| `packages/editor` | 学生の編集・記録・export。`typedcode.dev` |
| `packages/author` (新設) | 作問・鍵を使った配布物生成。`author.typedcode.dev` |
| `packages/verify` | 証明検証 UI。`verify.typedcode.dev` |
| `packages/verify-cli` | CLI 入出力と SDK の adapter。Web と別の配布物 |
| `packages/verifier` (ADR-0054 で新設) | 仕様別の検証・再生を外部へ提供する SDK |
| `packages/shared` と必要な内部ライブラリ | 記録・共通契約・暗号 primitive・実行器など。独立サービスにはしない |

製品コードが他アプリの `src` を直接 import する構造をなくす。author/editor が共有する実行器等は実際の依存に沿って内部ライブラリへ抽出し、暗号の型と規則をコピーしない。アプリ固有の画面・状態管理・翻訳はアプリが所有する。shared と verifier の循環依存を避け、双方が必要な形式の契約・primitive を下位へ置く。正確な内部パッケージ名は抽出時の依存を根拠に決める。

workspace のライブラリはアプリのビルドに取り込む。SDK の外部配布だけは compiled JS と型定義を用意する (ADR-0054)。共有ソースの変更は依存アプリの検証対象になるが、全アプリの同時公開は要求しない。

### 2. 配信・復旧

- 3 アプリを別 Pages プロジェクト、別成果物、別 origin にする。preview/staging もアプリごとに分ける。
- main 1 本、worktree、PR、既存の `v*` タグによるリリース記録を維持する。タグを検証済みスナップショットとし、公開は `app + environment + 検証済み成果物` を指定する操作へ分ける。従来のタグによる全アプリ・workers の自動一括更新を置換する。
- production の既存承認、main 祖先照合、nightly を含む検査は維持する。SDK 公開・workers 公開は別の明示的対象とする。これは新ゲートの追加ではなく既存公開手順の対象分離である。
- 同じ app/environment への公開を直列化し、無関係のアプリの公開を止めない。共通手順は再利用する。
- アプリ、環境、commit SHA、成果物 digest、配信 ID を記録する。対象環境で確認した同一成果物を公開・復旧する。staging と production は Turnstile/API のビルド時設定が異なるため別成果物であり、同じファイルだとは扱わない。
- 新形式の出力後はその形式に対応した読み手までを復旧可能な下限とする。鍵失効等の信頼情報を巻き戻す場合は、古い成果物への rollback より最新の信頼情報を含む修正版の公開を選ぶ。

当初は既存の全体 CI を維持してよい。変更パスに応じたテスト省略や新しいモノレポ管理製品は導入の条件にしない。

#### リリースチャンネル (ADR-0055) との関係

この ADR を書いた後に [ADR-0055](0055-release-channels-and-calendar-versioning.md) が先に実装された (#842〜#844)。ADR-0055 §9 のとおり、後から実装するこちらが、先に入った形へ合わせる。

- タグの付け方 (beta 版・正式版・patch) と、production へ出る契機が正式版への昇格と `release/A.B` の patch だけであることは、ADR-0055 のまま変えない。この ADR が決めるのは公開の単位 (アプリ + 環境) である。
- 分割後の構成へ production を切り替えるのは、分割を含む最初の正式版のときにする。`release/A.B` はそのブランチが持つ `deploy.yml` で配信されるので、旧構成の正式版が現役の間は、旧構成の Pages プロジェクトと Environment `production` の secrets を残す。
- beta 環境 (#845) は、アプリ別の origin と Pages (#808) の後に足す。
- アプリを指定する公開を、昇格・patch の手順とどう組み合わせるかは [#859](https://github.com/shinyaoguri/typedcode/issues/859) の着手時に決める。

### 3. URL と origin の移行

`/author`・`/author.html`・`/verify` の従来の入口は各正規ホストへ転送し、editor origin に author の実働ページを残さない。新しい URL と古い入口の関係、query 等の扱いを配信テストで確かめる。内部リンク・アセット base・Worker・COOP/COEP・必要な API 許可を環境別にそろえる。verify は署名 API を呼ばないため、そのためだけに CORS を広げない。

保存領域、File System Access の許可、教材フォルダのハンドルは origin をまたいで自動移行しない。利用者なしの移行では新 origin でフォルダを開き直し、設定を選び直す。秘密鍵や監督コードを URL・共有 Cookie・自動移送で引き継がない。author 内のコード試行の sandbox は別途必要であり、サブドメイン化だけで実行隔離を完了としない。

## Consequences

### Positive

- author/verify の変更・公開・復旧を独立して進められる。
- 同一リポジトリの契約修正・型検査・fixture を利用できる。
- author の鍵と editor/verify の保存領域を origin で分離できる。

### Negative / Trade-offs

- 配信先、preview URL、開発サーバー、アプリ別の公開履歴を管理する必要がある。
- shared を同じソースから作っても、本番の各アプリは異なる commit になりうる。ファイル形式による互換性管理が必要 (ADR-0053)。
- #792 系の進行中のファイル移動と競合しうる。着手時に最新 main と関連 PR を確認し、受け入れ条件を無断で変更しない (2026-11-20 追記: #792 系は #800 まで完了し、この競合は解消した)。

### Follow-ups / 残課題

- [#807](https://github.com/shinyaoguri/typedcode/issues/807): author パッケージと共通実行器の抽出。
- [#808](https://github.com/shinyaoguri/typedcode/issues/808): Pages/URL/環境/公開・復旧の分離。3 つに分けて進める (2026-11-20 メンテナ決定): [#857](https://github.com/shinyaoguri/typedcode/issues/857) verify の origin (#807 を待たずに始められる)、[#858](https://github.com/shinyaoguri/typedcode/issues/858) author の origin (#807 の後)、[#859](https://github.com/shinyaoguri/typedcode/issues/859) アプリと環境を指定した公開・復旧 (最後)。
- [#804](https://github.com/shinyaoguri/typedcode/issues/804): 全体の完了条件。
- 上記実装時に CONTRIBUTING、各 AGENTS.md・README・system-spec の現在の挙動を更新する。この文書 PR は将来の構成を実装済みと書き換えない。

## References

- [ADR-0011](0011-course-modes-and-path-routing.md)、[ADR-0028](0028-tag-based-github-flow.md)、[ADR-0030](0030-dev-port-autoswitch.md)、[ADR-0049](0049-staging-turnstile-testing-keys.md)、[ADR-0051](0051-authoring-from-local-material-folder.md)
- [ADR-0053](0053-versioned-verification-contracts.md)、[ADR-0054](0054-public-verification-and-replay-sdk.md)、[ADR-0055](0055-release-channels-and-calendar-versioning.md)
- [現行 deploy](../../.github/workflows/deploy.yml)、[author](../../packages/editor/src/authoring/AuthorPage.ts)、[verify の base](../../packages/verify/vite.config.ts)
- [Cloudflare Pages: Monorepos](https://developers.cloudflare.com/pages/configuration/monorepos/)、[CI からの Direct Upload](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/)
- [内部パッケージを利用側でコンパイルする選択肢](https://turborepo.dev/docs/core-concepts/internal-packages) (ツールの採用を意味しない)
