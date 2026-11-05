# TypedCode

<img align="right" src="icon.png" alt="TypedCode Logo" height="150">

[![CI](https://img.shields.io/github/actions/workflow/status/shinyaoguri/typedcode/deploy.yml?branch=main&label=CI)](https://github.com/shinyaoguri/typedcode/actions/workflows/deploy.yml)
[![Live](https://img.shields.io/website?url=https%3A%2F%2Ftypedcode.dev&label=typedcode.dev)](https://typedcode.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)
![Node](https://img.shields.io/badge/Node-%E2%89%A524-339933?logo=node.js&logoColor=white)

> **🚧 Work in Progress**
>
> このプロジェクトは活発に開発中です。破壊的変更・バグ・未完成の機能があり得ます。問題や提案があれば [Issue](https://github.com/shinyaoguri/typedcode/issues) でお知らせください。

[TypedCode](https://typedcode.dev) は、すべてのキーストロークを SHA-256 ハッシュチェーンと Proof of Sequential Work (PoSW) に記録する、改ざん耐性を備えた VSCode 風のコードエディタです。記録された編集列は改ざん耐性があり（署名チェックポイントがある場合は時刻アンカリングも付く）、エクスポート後の改変を検出できます。すべてブラウザ内で動作し、C / C++ は WebAssembly (Wasmer)、Python は WebAssembly (Pyodide)、JavaScript / TypeScript はブラウザ内で実行します。

主たる用途は、プログラミング試験・課題で**コピペや一括生成を排除し、打鍵の過程を検証可能にする**ことです。AI の利用そのものを防ぐ仕組みではありません ([防ぐもの / 防がないもの](#防ぐもの--防がないもの) 参照)。

**無料・無制限・サインアップ不要。ソースコードと打鍵内容はブラウザ外に出ません。**

サーバへ送られるのは、人間確認 (Cloudflare Turnstile) のトークンと、時刻アンカーのための**不透明なハッシュ・時刻・クライアント生成の識別子**だけです (セッション開始時の `sessionId` + フィンガープリントのハッシュ、署名チェックポイントのチェーン/コンテンツハッシュと時刻)。コード・キーストローク・個人情報は送信せず、証明の保管もしません ([ADR-0011 §5](docs/adr/0011-course-modes-and-path-routing.md))。

## 防ぐもの / 防がないもの

TypedCode が暗号学的に保証するのは、記録された編集列が後から改変されていないことと、署名チェックポイントがある場合にその記録がサーバの署名した時刻に存在していたことです。「本人が自分の力で打った」ことは証明しません。同じ内容はエクスポート ZIP に同梱される README の「証明できること / 証明できないこと」にも書いてあり、根拠は [システム仕様 §8](docs/system-spec.md) にあります。

**防ぐもの**

- **記録後の改ざん**: エクスポート後に記録イベントを 1 ビットでも変えると、SHA-256 ハッシュチェーン / PoSW の検証で失敗する
- **最終コードのすり替え**: エクスポートしたコードが記録された編集列の再生結果と一致しなければ、検証で失敗する
- **エディタへの貼り付け・ドロップ・一括挿入**: 打鍵とは別の種別で記録され、検証結果に現れる (読み手の判断材料であって、暗号的な保証ではない)
- **時刻の後付け** (署名チェックポイントがある場合): 記録がサーバの署名した時刻に存在していたことを示す。署名を後からまとめて取った記録には、疑いの警告 (post-hoc) が付く
- **事前の解答・別の問題へのすり替え** (試験モード): 解答のチェーンを、配布した問題と試験開始 (T0) 以降に暗号学的に束縛する

**防がないもの**

- **書き写し**: 手元の画面 (同じマシンの別ウィンドウなど) や別の端末に出した AI の出力・他人のコードを見ながら打ち直したものも、正しい証明になる。試験モードでも、試験時間内・同一マシンでの書き写しは防げない (監督者と後段の挙動分析が担う)
- **外部の支援**: AI・他人・資料の助けを借りていないこと
- **本人性**: 誰が打ったか。フィンガープリントは環境の識別であって個人の識別ではない (試験では提出先の LMS が担う)
- **人間が打ったこと**: スクリプトで合成・注入したイベントも同じく正しい証明になる。Turnstile の人間確認と打鍵パターンの分析は読み手の判断材料であって、暗号的な保証ではない
- **コードの品質・正しさ**

## 主な機能

- **改ざん耐性のある証明**: SHA-256 ハッシュチェーン + Proof of Sequential Work (PoSW)
- **時刻アンカリング**: サーバ署名済みチェックポイント (ECDSA-P256) による、後付け改ざんに強い時刻バインディング。さらに**セッション開始トークン** (ADR-0017) でチェーン根の開始時刻もサーバアンカーし、オフライン捏造を封じる
- **人間認証**: Cloudflare Turnstile。セッション開始時は ECDSA 署名のセッション開始トークン (ADR-0017)、エクスポート前は Turnstile の検証結果を署名せずに記録 (#415)
- **網羅的なイベント追跡**: コンテンツ変更・キーストローク・マウス・フォーカス・可視性・ペースト/ドロップ検出・テンプレート注入・セッション復旧などを記録 (一覧は [`events.ts`](packages/shared/src/types/events.ts))
- **マルチタブ**: 複数ファイルを同時に編集し、タブ切替も追跡
- **スクリーンショット**: 定期撮影とフォーカス喪失時の撮影、ハッシュ検証付き
- **ブラウザ内実行**: C / C++ は Wasmer SDK、Python は Pyodide (どちらも WebAssembly)、JavaScript / TypeScript はブラウザ内で実行
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
| [@typedcode/e2e](packages/e2e/) | Playwright E2E テスト (実エディタで証明を生成し verify-cli で round-trip 検証) |

## ライブデモ

- **エディタ**: [https://typedcode.dev](https://typedcode.dev)
- **検証アプリ**: [https://typedcode.dev/verify](https://typedcode.dev/verify)

## クイックスタート

### 1. 依存関係をインストール

```bash
npm install
```

### 2. 環境セットアップ

詳細手順とチェックリストは [docs/setup.md](docs/setup.md) を参照。**動作確認は doctor で**:

```bash
npm run doctor          # ローカル設定をチェック
npm run doctor -- --cf  # Cloudflare 側 (KV / wrangler 認証) も検証
```

未設定のものは「**何を、どこに、どう書くか**」が出力されるので、それに沿って 1 つずつ潰していきます。

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

ユニットテストは shared / editor / verify / verify-cli / workers にあります (Vitest)。CI は `test:coverage` を持つ**全ワークスペース**をカバレッジ付きで回し (各パッケージのカバレッジの床を下回ると失敗)、さらに別 job で E2E (Playwright) を実行します。どちらもデプロイのゲートです。テストの方針は [ADR-0034](docs/adr/0034-replace-manual-verification-with-automated-tests.md) と [CONTRIBUTING.md](CONTRIBUTING.md) の「完了の定義」を参照。

```bash
# CI と同じ検査を 1 コマンドで (typecheck → lint → カバレッジ付きユニットテスト → E2E)
npm run check
npm run check:fast   # E2E を除く

# CI と同じユニットテスト一式 (カバレッジ付き)
npm run test:coverage

# 個別実行 / カバレッジ
npm run test:run -w @typedcode/shared
npm run test:coverage -w @typedcode/shared

# E2E (編集 → export → verify-cli の round-trip)
npm run test -w @typedcode/e2e
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

単一タブは `{filename}_TC{timestamp}.zip`、全タブ一括は `ALL_TC{timestamp}.zip` として出力され、以下を含みます:

- `{filename}.{ext}` — ソースコード
- `{filename}_proof.json` — 証明 JSON (下記構造)
- `screenshots/` — 撮影された画面 (JPEG)
- `screenshots/manifest.json` — スクリーンショットのハッシュとメタデータ
- `README.md` — 検証手順 (英語)
- `README.ja.md` — 検証手順 (日本語)

**証明 JSON の構造:**
```json
{
  "version": "1.2.0",
  "typingProofHash": "sha256...",
  "typingProofData": { "finalContentHash": "...", "metadata": {...} },
  "proof": { "events": [...], "finalHash": "..." },
  "fingerprint": { "deviceId": "...", "components": {...} },
  "checkpoints": [...],
  "sessionStartToken": { "payload": {...}, "signature": "...", "keyId": "..." },
  "rootAnchored": true
}
```

> `sessionStartToken` / `rootAnchored` は ADR-0017 (casual/class の root サーバアンカー) で加わった任意フィールド。session/start が成功したときのみ付き、無くても (旧 proof / オフライン) 検証は通る (後方互換、`MIN_SUPPORTED_VERSION` 1.0.0 据え置き)。

## 技術スタック

| レイヤー | 技術 |
|-------|------------|
| エディタ | Monaco Editor, xterm.js |
| 実行環境 | Wasmer SDK (C / C++)、Pyodide (Python)。どちらも WebAssembly |
| 検証 UI | Chart.js, Highlight.js |
| ビルド | Vite 8, TypeScript 7 |
| Workers | Cloudflare Workers, Wrangler |
| テスト | Vitest |

## 関連ドキュメント

- [docs/system-spec.md](docs/system-spec.md) — システム仕様書 (詳細)
- [AGENTS.md](AGENTS.md) — プロジェクト概要と、AI エージェントと人間に共通する規約の正本 (Claude Code は [CLAUDE.md](CLAUDE.md) から読み込む)

## ライセンス

MIT License
