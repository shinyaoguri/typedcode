# AGENTS.md

このファイルは、本リポジトリで作業する AI エージェント (Claude Code・Codex など) と人間に共通する規約の正本です (#351)。詳細はサブシステムの `AGENTS.md` と `docs/` に委譲しています。Claude Code は `CLAUDE.md` の `@AGENTS.md` からこのファイルを読み込みます。特定のエージェントにしか効かない設定 (Claude Code のサブエージェントなど) は、そのエージェント用のファイル (`CLAUDE.md`・`.claude/`) に置きます。

## プロジェクト概要

TypedCode はブラウザベースのコードエディタで、すべてのキーストロークを SHA-256 ハッシュチェーンと Proof of Sequential Work (PoSW) に記録し、改ざん耐性のあるタイピング証明を生成します。さらに Cloudflare Workers による ECDSA-P256 署名付きチェックポイントで時刻アンカリングを行います。

**Version**: 1.1.0
**Tech Stack**: TypeScript 6, Vite 8 (rolldown), Monaco Editor, Wasmer SDK, Chart.js, Cloudflare Workers
**Node.js**: ≥24

## パッケージ構成

```
packages/
├── shared/     # コアライブラリ: TypingProof, Fingerprint, 検証, 型定義
├── editor/     # Monaco ベースのエディタ
├── verify/     # 証明検証用 Web アプリ
├── verify-cli/ # CLI 検証ツール (Node.js ≥24)
├── workers/    # Cloudflare Workers (Turnstile + 署名チェックポイント)
└── e2e/        # Playwright E2E (編集→export→verify-cli round-trip、CI deploy ゲート)
```

サブシステムを触る場合は **必ず該当パッケージの `AGENTS.md`** を読むこと。各パッケージの責務 / 境界 / 不変条件 / 罠が記述されています。

| パッケージ | AGENTS.md | 主な責務 |
|---|---|---|
| shared | [packages/shared/AGENTS.md](packages/shared/AGENTS.md) | 暗号証明エンジン、型定義の単一ソース |
| editor | [packages/editor/AGENTS.md](packages/editor/AGENTS.md) | キーストローク記録、エクスポート |
| verify | [packages/verify/AGENTS.md](packages/verify/AGENTS.md) | 証明検証 UI、Worker ベースの検証 |
| verify-cli | [packages/verify-cli/AGENTS.md](packages/verify-cli/AGENTS.md) | CLI 検証ツール |
| workers | [packages/workers/AGENTS.md](packages/workers/AGENTS.md) | Turnstile + 署名チェックポイントの API |
| e2e | [packages/e2e/AGENTS.md](packages/e2e/AGENTS.md) | ブラウザ E2E (実エディタ → 証明 export → verify-cli 検証) |

## ビルド・開発コマンド

```bash
# 依存関係のインストール
npm install

# 開発 (全パッケージ同時。ポートは自動割当 = ADR-0030:
# 既定 editor 5173 / verify 5174 / workers 8787、使用中ならセットごと +10 へ。
# 実際の URL は起動バナーに表示され、プロキシ / VITE_API_URL も自動追従)
npm run dev

# 開発 (個別。こちらは従来どおりの固定ポート 5173 / 5174 / 8787)
npm run dev:editor / dev:verify / dev:workers

# ビルド (全パッケージ。個別は build:editor / build:verify / build:verify-cli)
npm run build

# Lint / Format (Biome, #157。CI の check job も同じコマンド)
npm run lint        # biome ci . + lint:docs (チェックのみ。CI の check job も同じコマンド)
npm run lint:docs   # docs/ とルートの *.md に [[...]] 形式のローカル記憶参照が残っていないか (#343)
npm run lint:fix    # biome check --write . (安全な自動修正 + format)
npm run lint:workflows  # .github/workflows を actionlint + shellcheck で検査 (版と sha256 を固定して .cache/ に落とす。#351)

# ユニットテスト (カバレッジ付き。test:coverage を持つ全パッケージ。CI の test job も同じコマンド)
npm run test:coverage                       # = npm run test:coverage --workspaces --if-present
npm run test:run -w @typedcode/shared       # 個別実行 (カバレッジ無し。test:coverage も同様に -w で)
npm run coverage:ratchet                    # カバレッジが上がったら各 vitest.config.ts の床を引き上げる (ADR-0034)

# E2E (Playwright。workers + editor の dev サーバを自動起動して round-trip 検証)
npm run test -w @typedcode/e2e
# 注: CI は「ユニット (test job) + e2e (e2e job)」を全 deploy のゲートにしている

# 手元で CI と同じ検査を 1 コマンドで (完了の定義 = CONTRIBUTING.md / ADR-0034)
npm run check       # typecheck → lint → lint:workflows → test:coverage → require-tests のテスト → e2e
npm run check:fast  # 上から e2e を除いたもの
```

## 開発フロー

- ブランチ運用は**タグ式 GitHub Flow** (main 1 本 + `v*` タグ → production)。手順は [CONTRIBUTING.md](CONTRIBUTING.md)、根拠は [ADR-0028](docs/adr/0028-tag-based-github-flow.md)
- **作業は git worktree で行う** (メインのチェックアウトのブランチを切り替えない)
- **マージしたら、メインのチェックアウトから `git sweep` を実行して** worktree とローカルブランチを掃除する (使用中・dirty な worktree は自動スキップ。[ADR-0029](docs/adr/0029-merge-cleanup-script.md))
- PR タイトルは CI (`pr-title` job) が Conventional Commits を検査する。落ちたら型を `feat|fix|docs|refactor|test|chore|ci` から選び直す
- **新しい仕組みは実害を示せるときだけ足す**: 新しいゲート・検査・フック・ラベル・ワークフローは、塞ぐ実害を Issue 番号で示せるときだけ足す (消すときは要らない)。「あると良さそう」なら起票して待たせる

## Issue と着手

Issue の起票から PR の close までの規律はこの節で完結する。判断の根拠は [ADR-0035](docs/adr/0035-triage-gate-for-issues.md)。

### 進め方

1. 変更は Issue の起票から始める。起票は雑でよい。未トリアージの Issue を調べて受け入れ条件を本文に書くところまでは、着手を待たずにしてよい (ラベルは付けない)
2. **着手できるのは `verify: triaged` の付いた Issue だけ**。このラベルはメンテナが付ける。エージェントが付けてよいのは、自分で起票し受け入れ条件を書いた Issue だけ。着手したら `status: in progress` を付け、merge か中断で外す
3. 着手時に、Issue 本文と全コメントを読み、各受け入れ条件を現行コードと突き合わせて「まだ有効 / 既に満たされている / 差し替えが要る」をプランに書く。事実のずれ (行番号・綴り・数) は先に本文を直す。条件を緩める・絞る・差し替えるときは、本文は直さず根拠をコメントして人の判断を待つ
4. プラン (変更点・確認方法) を Issue にコメントする。PR を出した後に変わったら、差分を PR にコメントする
5. PR 本文の「Test plan」に、閉じる Issue ごとに受け入れ条件と確かめ方の対応表を置く (形は [PR テンプレート](.github/pull_request_template.md))。`Closes #N` は PR 本文に書く

移行: ゲートを入れた時点 (#377) で既に `status: in progress` の Issue は、印が無くても続けてよい。

### 作業中に踏んだ問題

起票の時点で行き先まで決める。グローバルな個人規約の「本題以外は直さず起票」より、この表が優先する。

| 踏んだもの | 行き先 |
|---|---|
| その PR の説明で筋が通る (同じ根の兄弟は常にここ) | 起票して、その PR で閉じる (既定) |
| 根が違い、受け入れ条件は書ける | 起票し、受け入れ条件を本文に書いて `verify: triaged` まで付ける |
| 受け入れ条件を書けない (仕様や方針の選択が要る) | ラベルなしで置き、メンテナの判断を待つ |

### Issue 本文に書くこと

[Issue テンプレート](.github/ISSUE_TEMPLATE/) がこの型を強制する。

- **目的**: なぜやるのか。関連する ADR / [docs/system-spec.md](docs/system-spec.md) / 既存 Issue と対応付ける
- **内容**: 何をつくるか。実装方針が決まっている場合はその理由も
- **受け入れ条件**: いまのコードで確かめられる言い方で書く (「〜が改善されている」ではなく「〜を打つと〜になる」「〜という検査がある」)。入力・操作と、現在の結果・期待する結果の具体例を 1 つ以上置く。自動テストか手動確認かの別も書く
- **関連情報**: 該当ファイル・docs・ADR・依存 Issue へのリンク。前提知識のポインタを惜しまない
- **スコープ外**: やらないことを明示し、スコープの膨張を防ぐ

### コメントの置き場

- 置き場は、PR ができるまでは Issue、できてからは PR。受け入れ条件が動く話は Issue、恒久的な設計判断は ADR
- close の根拠は閉じた PR の対応表なので、Issue に完了報告は書かない。PR をマージしても残作業があるなら、Issue は閉じずに残作業をコメントする
- **引き継ぎの真実は GitHub に置く**: 重要な決定・発見 (試して駄目だったアプローチ、既存コードの罠) はその場でコメントに記録する。中断時は「完了・残作業・注意点・次の一歩」の引き継ぎコメントを残す。セッションメモリ・チャット履歴は効率化のために使ってよいが、**そこにしかない情報を作らない**
- **人が読み止められる本文にする**: エージェントが新しく書く Issue / PR の本文と長いコメント (目安 1,000 字超) は、先頭に 3 行以内の `**要約**:` と `**人が判断すること**:` (無ければ「なし」) を置き、詳細はその後に続けるか `<details>` に畳む (PR テンプレートの先頭と同じ形)

### ラベル

- **状態ラベル**: `status: in progress` (着手中。並行セッションの重複を避ける) / `verify: triaged` (受け入れ条件が固まり、着手してよい)
- **種類ラベル** (Issue / PR に一つ): `bug` / `enhancement` / `documentation` / `security` など。Issue テンプレートが自動で付けるものはそのまま使う (#378 で `type:*` に置き換える予定)
- **パッケージラベル** (`pkg:shared` / `pkg:editor` / `pkg:verify` / `pkg:workers` / `pkg:e2e` / `pkg:repo`): PR には変更ファイルから labeler が自動で付ける ([.github/labeler.yml](.github/labeler.yml))。Issue には着手対象が明らかな場合に手で付ける
- `severity:*` はレビュー・トリアージ時の重要度の明示に使う

## ドキュメント階層

仕様は [docs/system-spec.md](docs/system-spec.md) (定数・アルゴリズム・用語集)、判断の根拠は [docs/adr/](docs/adr/)、開発の進め方は [CONTRIBUTING.md](CONTRIBUTING.md)、変更履歴は [CHANGELOG.md](CHANGELOG.md) が真実の在処です。コードの触り方は本ファイルと `packages/*/AGENTS.md`、利用者視点の使い方は `packages/*/README.md` にあります。

## 環境設定

初回セットアップ (`.env` / `.dev.vars` の作成、Turnstile と署名鍵の用意) の手順は [docs/setup.md](docs/setup.md)、各変数の意味と不変条件は [packages/workers/AGENTS.md](packages/workers/AGENTS.md) を参照。**秘密情報を AGENTS.md や docs に書き写さないこと** (置き場は gitignore 済みの `.env` / `.dev.vars` のみ)。

## i18n

対応ロケール: `ja` (日本語), `en` (English)
検出順序: localStorage → ブラウザ言語 → 既定 (`ja`)

翻訳ファイル: `packages/{editor,verify}/src/i18n/translations/{ja,en}.ts`
型: `packages/{editor,verify}/src/i18n/types.ts` (新キー追加時は型も同時更新)
