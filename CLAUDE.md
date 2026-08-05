# CLAUDE.md

このファイルは Claude Code (claude.ai/code) と Claude Agent SDK が本リポジトリで作業するときの起点となるガイドです。詳細はサブシステムの `CLAUDE.md` と `docs/` に委譲しています。

## プロジェクト概要

TypedCode はブラウザベースのコードエディタで、すべてのキーストロークを SHA-256 ハッシュチェーンと Proof of Sequential Work (PoSW) に記録し、改ざん耐性のあるタイピング証明を生成します。さらに Cloudflare Workers による ECDSA-P256 署名付きチェックポイントで時刻アンカリングを行います。

**Version**: 1.1.0
**Tech Stack**: TypeScript 5/6, Vite 8 (rolldown), Monaco Editor, Wasmer SDK, Chart.js, Cloudflare Workers
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

サブシステムを触る場合は **必ず該当パッケージの `CLAUDE.md`** を読むこと。各パッケージの責務 / 境界 / 不変条件 / 罠が記述されています。

| パッケージ | CLAUDE.md | 主な責務 |
|---|---|---|
| shared | [packages/shared/CLAUDE.md](packages/shared/CLAUDE.md) | 暗号証明エンジン、型定義の単一ソース |
| editor | [packages/editor/CLAUDE.md](packages/editor/CLAUDE.md) | キーストローク記録、エクスポート |
| verify | [packages/verify/CLAUDE.md](packages/verify/CLAUDE.md) | 証明検証 UI、Worker ベースの検証 |
| verify-cli | [packages/verify-cli/CLAUDE.md](packages/verify-cli/CLAUDE.md) | CLI 検証ツール |
| workers | [packages/workers/CLAUDE.md](packages/workers/CLAUDE.md) | Turnstile + 署名チェックポイントの API |
| e2e | [packages/e2e/CLAUDE.md](packages/e2e/CLAUDE.md) | ブラウザ E2E (実エディタ → 証明 export → verify-cli 検証) |

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
npm run lint        # biome ci . (チェックのみ)
npm run lint:fix    # biome check --write . (安全な自動修正 + format)

# ユニットテスト (test:run を持つ全パッケージ。CI の test job も同じコマンド)
npm run test:run --workspaces --if-present
npm run test:run -w @typedcode/shared      # 個別実行 (test:coverage も同様)

# E2E (Playwright。workers + editor の dev サーバを自動起動して round-trip 検証)
npm run test -w @typedcode/e2e
# 注: CI は「ユニット (test job) + e2e (e2e job)」を全 deploy のゲートにしている
```

## 開発フロー

- ブランチ運用は**タグ式 GitHub Flow** (main 1 本 + `v*` タグ → production)。手順は [CONTRIBUTING.md](CONTRIBUTING.md)、根拠は [ADR-0028](docs/adr/0028-tag-based-github-flow.md)
- **作業は git worktree で行う** (メインのチェックアウトのブランチを切り替えない)
- **マージしたら、メインのチェックアウトから `git sweep` を実行して** worktree とローカルブランチを掃除する (使用中・dirty な worktree は自動スキップ。[ADR-0029](docs/adr/0029-merge-cleanup-script.md))
- PR タイトルは CI (`pr-title` job) が Conventional Commits を検査する。落ちたら型を `feat|fix|docs|refactor|test|chore|ci` から選び直す
- **引き継ぎの真実は Issue に置く**: 着手時は Issue 本文と全コメントを読む。重要な決定・発見はその場で Issue コメントに記録し、中断時は「完了・残作業・注意点・次の一歩」の引き継ぎコメントを残す。セッションメモリ・チャット履歴は効率化のために使ってよいが、**そこにしかない情報を作らない** (詳細は CONTRIBUTING「Issue の書き方と引き継ぎ」)

## モデルの役割分担 (コスト最適化)

メインセッションを高コストモデル (Fable など) で走らせている場合、**まとまったコード編集をメインループで直接行わない**。実装は `.claude/agents/` のサブエージェントに委譲し、メインループは要件整理・設計判断・タスク分解・結果レビュー・ユーザーへの報告に徹する。

| エージェント | モデル | 使いどころ |
|---|---|---|
| `implementer` | Opus (現行 Opus 4.8) | 方針が固まった実装。複数ファイル編集・新機能・リファクタ・テスト作成 |
| `mechanic` | Sonnet (現行 Sonnet 5) | 機械的変更。rename / i18n キー追加 / typo / 定型修正 / lint 対応 |

- 目安: **2 ファイル以上 or 数十行超**の編集は委譲する (数行の単発修正は往復のオーバーヘッドが上回る)
- 設計判断・コードレビュー・ADR / CLAUDE.md の更新はメインループが担う (委譲しない)

## ドキュメント階層

仕様は [docs/system-spec.md](docs/system-spec.md) (定数・アルゴリズム・用語集)、判断の根拠は [docs/adr/](docs/adr/)、開発の進め方は [CONTRIBUTING.md](CONTRIBUTING.md)、変更履歴は [CHANGELOG.md](CHANGELOG.md) が真実の在処です。コードの触り方は本ファイルと `packages/*/CLAUDE.md`、利用者視点の使い方は `packages/*/README.md` にあります。

## 環境設定

初回セットアップ (`.env` / `.dev.vars` の作成、Turnstile と署名鍵の用意) の手順は [docs/setup.md](docs/setup.md)、各変数の意味と不変条件は [packages/workers/CLAUDE.md](packages/workers/CLAUDE.md) を参照。**秘密情報を CLAUDE.md や docs に書き写さないこと** (置き場は gitignore 済みの `.env` / `.dev.vars` のみ)。

## i18n

対応ロケール: `ja` (日本語), `en` (English)
検出順序: localStorage → ブラウザ言語 → 既定 (`ja`)

翻訳ファイル: `packages/{editor,verify}/src/i18n/translations/{ja,en}.ts`
型: `packages/{editor,verify}/src/i18n/types.ts` (新キー追加時は型も同時更新)
