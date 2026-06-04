# CLAUDE.md

このファイルは Claude Code (claude.ai/code) と Claude Agent SDK が本リポジトリで作業するときの起点となるガイドです。詳細はサブシステムの `CLAUDE.md` と `docs/` に委譲しています。

## プロジェクト概要

TypedCode はブラウザベースのコードエディタで、すべてのキーストロークを SHA-256 ハッシュチェーンと Proof of Sequential Work (PoSW) に記録し、改ざん耐性のあるタイピング証明を生成します。さらに Cloudflare Workers による ECDSA-P256 署名付きチェックポイントで時刻アンカリングを行います。

**Version**: 1.0.0
**Tech Stack**: TypeScript 5/6, Vite 8 (rolldown), Monaco Editor, Wasmer SDK, Chart.js, Cloudflare Workers
**Node.js**: ≥24

## パッケージ構成

```
packages/
├── shared/     # コアライブラリ: TypingProof, Fingerprint, 検証, 型定義
├── editor/     # Monaco ベースのエディタ
├── verify/     # 証明検証用 Web アプリ
├── verify-cli/ # CLI 検証ツール (Node.js ≥24)
└── workers/    # Cloudflare Workers (Turnstile + 署名チェックポイント)
```

サブシステムを触る場合は **必ず該当パッケージの `CLAUDE.md`** を読むこと。各パッケージの責務 / 境界 / 不変条件 / 罠が記述されています。

| パッケージ | CLAUDE.md | 主な責務 |
|---|---|---|
| shared | [packages/shared/CLAUDE.md](packages/shared/CLAUDE.md) | 暗号証明エンジン、型定義の単一ソース |
| editor | [packages/editor/CLAUDE.md](packages/editor/CLAUDE.md) | キーストローク記録、エクスポート |
| verify | [packages/verify/CLAUDE.md](packages/verify/CLAUDE.md) | 証明検証 UI、Worker ベースの検証 |
| verify-cli | [packages/verify-cli/CLAUDE.md](packages/verify-cli/CLAUDE.md) | CLI 検証ツール |
| workers | [packages/workers/CLAUDE.md](packages/workers/CLAUDE.md) | Turnstile + 署名チェックポイントの API |

## ビルド・開発コマンド

```bash
# 依存関係のインストール
npm install

# 開発 (全パッケージ同時)
npm run dev

# 開発 (個別)
npm run dev:editor    # http://localhost:5173
npm run dev:verify    # http://localhost:5174
npm run dev:workers   # http://localhost:8787

# ビルド
npm run build              # 全パッケージ
npm run build:editor
npm run build:verify
npm run build:verify-cli

# テスト (shared のみテストあり)
npm run test -w @typedcode/shared
npm run test:coverage -w @typedcode/shared
```

## ドキュメント階層

- **CLAUDE.md (本ファイル)**: 玄関口 / ナビゲーション
- **`packages/*/CLAUDE.md`**: サブシステム固有の責務・不変条件・罠
- **[docs/system-spec.md](docs/system-spec.md)**: クロスカット仕様 (定数、アルゴリズム、用語集)
- **[docs/adr/](docs/adr/)**: 設計判断の蓄積 (Architecture Decision Records)
- **`packages/*/README.md`**: ユーザー視点のドキュメント (API、使い方)

仕様は `docs/system-spec.md`、判断の根拠は `docs/adr/`、コードの触り方は `CLAUDE.md` が真実の在処です。

## 環境設定

### Editor (`packages/editor/.env`)
```
VITE_TURNSTILE_SITE_KEY=your_site_key
VITE_API_URL=http://localhost:8787
```

### Workers (`packages/workers/.dev.vars`)
```
TURNSTILE_SECRET_KEY=your_secret_key
ATTESTATION_SECRET_KEY=any_random_string
CHECKPOINT_SIGNING_KEY_ID=...        # gen-checkpoint-key で生成
CHECKPOINT_SIGNING_KEY_JWK={...}     # gen-checkpoint-key で生成
```

詳細は [packages/workers/CLAUDE.md](packages/workers/CLAUDE.md) を参照。

## i18n

対応ロケール: `ja` (日本語), `en` (English)
検出順序: localStorage → ブラウザ言語 → 既定 (`ja`)

翻訳ファイル: `packages/{editor,verify}/src/i18n/translations/{ja,en}.ts`
型: `packages/{editor,verify}/src/i18n/types.ts` (新キー追加時は型も同時更新)
