# TypedCode

<img align="right" src="icon.png" alt="TypedCode Logo" height="150">

> **🚧 Work in Progress**
>
> このプロジェクトは活発に開発中です。破壊的変更・バグ・未完成の機能があり得ます。問題や提案があれば [Issue](https://github.com/shinyaoguri/typedcode/issues) でお知らせください。

[TypedCode](https://typedcode.dev) は、すべてのキーストロークを SHA-256 ハッシュチェーンと Proof of Sequential Work (PoSW) に記録する、改ざん耐性を備えた VSCode 風のコードエディタです。コピー＆ペーストを使わずに 1 文字ずつタイプされたことを証明できます。すべてブラウザ内で動作し、C / C++ / Python / JavaScript / TypeScript の実行も WebAssembly 経由で行えます。

主たる用途は、AI 生成や自動コピーを防ぎたいプログラミング試験、および学習プロセスを検証したい教育現場です。

**無料・無制限・サインアップ不要。データはブラウザ外に出ません。**

## 主な機能

- **改ざん耐性のある証明**: SHA-256 ハッシュチェーン + Proof of Sequential Work (PoSW)
- **時刻アンカリング**: サーバ署名済みチェックポイント (ECDSA-P256) による、後付け改ざんに強い時刻バインディング
- **人間認証**: Cloudflare Turnstile と HMAC 署名済みアテステーション
- **網羅的なイベント追跡**: コンテンツ変更・キーストローク・マウス・フォーカス・可視性・ペースト/ドロップ検出・テンプレート注入・セッション復旧などを記録 (一覧は [`events.ts`](packages/shared/src/types/events.ts))
- **マルチタブ**: 複数ファイルを同時に編集し、タブ切替も追跡
- **スクリーンショット**: 定期撮影とフォーカス喪失時の撮影、ハッシュ検証付き
- **ブラウザ内実行**: Wasmer SDK (WebAssembly) で C / C++ / Python / JavaScript / TypeScript を実行
- **エクスポート形式**: 証明 JSON・ソースコード・スクリーンショット・検証手順を含む ZIP アーカイブ
- **日英バイリンガル UI**

## パッケージ構成

| パッケージ | 説明 |
|---------|-------------|
| [@typedcode/editor](packages/editor/) | Monaco ベースのエディタ。キーストローク追跡とコード実行を担当 |
| [@typedcode/verify](packages/verify/) | Web ベースの証明検証アプリ |
| [@typedcode/verify-cli](packages/verify-cli/) | CLI 検証ツール (Node.js ≥24) |
| [@typedcode/shared](packages/shared/) | コアライブラリ: TypingProof / Fingerprint / 検証 / 型定義 |
| [@typedcode/workers](packages/workers/) | Cloudflare Workers API (Turnstile 連携・チェックポイント署名) |

## ライブデモ

- **エディタ**: [https://typedcode.dev](https://typedcode.dev)
- **検証アプリ**: [https://typedcode.dev/verify](https://typedcode.dev/verify)

## クイックスタート

### 1. 依存関係をインストール

```bash
npm install
```

### 2. Turnstile を設定 (任意・人間認証を使う場合のみ)

人間認証には [Cloudflare Turnstile](https://www.cloudflare.com/products/turnstile/) が必要です。不要なら本ステップは省略可能です。

**エディタ側:**
```bash
cp packages/editor/.env.example packages/editor/.env
```

`packages/editor/.env` を編集:
```
VITE_TURNSTILE_SITE_KEY=your_site_key
VITE_API_URL=http://localhost:8787
```

**Workers 側:**
```bash
cp packages/workers/.dev.vars.example packages/workers/.dev.vars
```

`packages/workers/.dev.vars` を編集:
```
TURNSTILE_SECRET_KEY=your_secret_key
ATTESTATION_SECRET_KEY=any_random_string
```

Turnstile キーの取得: https://dash.cloudflare.com/?to=/:account/turnstile

### 3. 開発サーバを起動

```bash
# 全パッケージを同時起動 (editor + verify + workers)
npm run dev

# 個別起動
npm run dev:editor    # http://localhost:5173
npm run dev:verify    # http://localhost:5174
npm run dev:workers   # http://localhost:8787
```

## ビルド

```bash
# 全パッケージ
npm run build

# 個別ビルド
npm run build:editor
npm run build:verify
npm run build:verify-cli
```

## テスト

テストは shared パッケージで定義されています。

```bash
npm run test -w @typedcode/shared
npm run test:coverage -w @typedcode/shared
```

## アーキテクチャ

### 動作の流れ

1. **イベント記録**: ユーザー操作 (キーストローク・カーソル移動・ペーストなど) を型付きイベントとして捕捉
2. **ハッシュチェーン**: 各イベントを SHA-256 でハッシュ化し、前イベントのハッシュへ連結
3. **PoSW 計算**: Web Worker で各イベントごとに反復ハッシュ計算 (UI ブロックなし、反復数は `POSW_ITERATIONS` 固定)
4. **時刻アンカリング**: チェックポイントを Workers で署名 (ECDSA-P256) し、サーバ時刻を結びつける
5. **人間認証**: ファイル作成時とエクスポート前に Turnstile で人間確認
6. **エクスポート**: 全イベント履歴・ハッシュチェーン・フィンガープリント・スクリーンショットを含む証明ファイルを出力
7. **検証**: チェーン整合性・タイムスタンプ・PoSW・署名済みチェックポイントを独立に検証

### イベントタイプ

カテゴリ分けされた union 型として定義されています。一覧と分類は [`packages/shared/src/types/events.ts`](packages/shared/src/types/events.ts)、許可/禁止の方針は [docs/adr/0005-input-type-policy.md](docs/adr/0005-input-type-policy.md) を参照してください。

### エクスポートファイル形式 (ZIP)

`TC{timestamp}.zip` として出力され、以下を含みます:

- `{filename}.{ext}` — ソースコード
- `{filename}_proof.json` — 証明 JSON (下記構造)
- `screenshots/` — 撮影された画面 (JPEG)
- `screenshots/manifest.json` — スクリーンショットのハッシュとメタデータ
- `README.md` — 検証手順 (英語)
- `README.ja.md` — 検証手順 (日本語)

**証明 JSON の構造:**
```json
{
  "version": "1.0.0",
  "typingProofHash": "sha256...",
  "typingProofData": { "finalContentHash": "...", "metadata": {...} },
  "proof": { "events": [...], "finalHash": "..." },
  "fingerprint": { "deviceId": "...", "components": {...} },
  "checkpoints": [...]
}
```

## 技術スタック

| レイヤー | 技術 |
|-------|------------|
| エディタ | Monaco Editor, xterm.js |
| 実行環境 | Wasmer SDK (WebAssembly) |
| 検証 UI | Chart.js, Highlight.js |
| ビルド | Vite 8, TypeScript 5/6 |
| Workers | Cloudflare Workers, Wrangler |
| テスト | Vitest |

## 関連ドキュメント

- [docs/system-spec.md](docs/system-spec.md) — システム仕様書 (詳細)
- [CLAUDE.md](CLAUDE.md) — プロジェクト概要 (Claude Code 用)

## ライセンス

MIT License
