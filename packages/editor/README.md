# @typedcode/editor

エディタ本体アプリケーション。Monaco Editor をベースにした、連続タイピングを証明するエディタです。ブラウザ内でコード実行まで完結します。

## 機能

- **マルチタブ編集**: タブごとに独立した証明チェーン、タブ切替も追跡
- **対応言語**: C, C++, Python, JavaScript, TypeScript
- **テーマ**: ライト/ダークモード (システム設定の自動検出)
- **イベント追跡**: キーストローク・カーソル・ペースト/ドロップ・ウィンドウ・フォーカス・可視性などを記録 (一覧は [`@typedcode/shared` の `events.ts`](../shared/src/types/events.ts))
- **PoSW**: 反復シーケンシャルハッシュを Web Worker で計算 (反復数は `POSW_ITERATIONS` 固定)
- **スクリーンショット**: 定期撮影とフォーカス喪失時の撮影、ハッシュ検証付き
- **時刻アンカリング**: チェックポイントを Workers で ECDSA-P256 署名し、サーバ時刻と結びつける
- **人間認証**: ファイル作成時とエクスポート前に Cloudflare Turnstile を実行
- **エクスポート**: 証明 JSON・ソースコード・スクリーンショット・README を含む ZIP アーカイブ
- **i18n**: 日本語と英語の UI

## ブラウザ内コード実行

| 言語 | ランタイム | 補足 |
|----------|---------|---------|
| C | Wasmer SDK | Clang WASM、stdin/stdout 対応 |
| C++ | Wasmer SDK | Clang++ WASM |
| Python | Wasmer SDK | Python WASM ランタイム |
| JavaScript | ネイティブ | ブラウザ eval + console キャプチャ |
| TypeScript | SWC | JS にトランスパイルしてから eval |

## 開発

```bash
npm run dev      # http://localhost:5173
npm run build
npm run preview
```

## 主要な仕組み

### イベント記録の流れ

```
User Action
    ↓
InputDetector (paste/drop 検出)
    ↓
OperationDetector (Monaco 変更イベント → 操作種別)
    ↓
KeystrokeTracker / MouseTracker など
    ↓
EventRecorder (キューイング、fire-and-forget)
    ↓
TypingProof.recordEvent() (@typedcode/shared)
    ↓
HashChainManager → PoswManager (Web Worker)
    ↓
StoredEvent → localStorage + IndexedDB
```

### Fire-and-Forget 記録

UI をブロックせずにイベントを記録します。

1. `record(event)` は即座に返る
2. PoSW 計算は Web Worker で実行 (反復数は `POSW_ITERATIONS` 固定)
3. UI は処理中の件数を `queuedEventCount` で表示
4. イベントは IndexedDB へ逐次保存

これにより暗号処理の負荷があってもタイピングの応答性が保たれます。

### 内部ペースト検出

外部からの貼り付け (Ctrl+V) と、同一セッション内の自己コピーを区別します。

1. タイプされたコンテンツは `SessionContentRegistry` に登録
2. ペースト発生時、貼り付けテキストを登録済みコンテンツと照合
3. 一致 → `insertFromInternalPaste` (許可、ピュアタイピングを破らない)
4. 不一致 → `insertFromPaste` (禁止、外部入力としてマーク)

これにより、自身がタイプしたコードのコピー＆ペーストはペナルティなしで許容されます。

### 署名付きチェックポイント (時刻アンカリング)

直前のチェックポイントから **100 イベント** または **10 秒** のいずれかが先に成立した時点でチェックポイントを生成し、Workers の `/api/checkpoint/sign` で ECDSA-P256 署名と `serverTimestamp` を付与します。

- ネットワーク不安定下でも堅牢なよう、`SignedCheckpointService` はシングルフライトで順次フラッシュ
- 同一内容の再送はサーバ側の冪等処理 (`isIdempotentSigningRetry`) で吸収
- 署名失敗してもチェーン本体は継続 (best-effort)

### セッション復旧

ブラウザの再読み込みや予期せぬ終了に備えます。

1. イベントは IndexedDB へ逐次保存
2. リロード時に `sessionResumed` イベントを記録
3. 直前の保存状態からハッシュチェーンを継続
4. 未完了の PoSW 計算を再開

### テンプレート注入

試験のスターターコードなどテンプレートをロードする場合の扱い。

1. `templateInjection` イベントを記録
2. 注入されたコンテンツはユーザータイプ分とは別に追跡
3. ピュアタイピング判定はテンプレートとユーザー入力を区別して評価

## 環境変数

| 変数 | 説明 | 必須 |
|----------|-------------|----------|
| `VITE_TURNSTILE_SITE_KEY` | Turnstile サイトキー | 任意 |
| `VITE_API_URL` | Workers API のエンドポイント | 任意 |

## ビルド時に注入される情報

ビルドプロセスは以下の変数をソースに注入します。

```typescript
__APP_VERSION__      // package.json の version
__GIT_COMMIT__       // Git commit hash
__GIT_COMMIT_DATE__  // Git commit の日付
__BUILD_DATE__       // ビルド時刻
```

## 依存関係

| パッケージ | バージョン | 用途 |
|---------|---------|---------|
| monaco-editor | ^0.55 | コードエディタ本体 |
| @xterm/xterm | ^6.0 | ターミナルエミュレータ |
| @xterm/addon-fit | ^0.11 | ターミナルの自動リサイズ |
| @wasmer/sdk | ^0.10 | WebAssembly ランタイム |
| jszip | ^3.10 | ZIP エクスポート |
| yaml | ^2.9 | テンプレート YAML 解析 |
| vite | ^8.0 | ビルドツール (rolldown) |
| vite-plugin-wasm | ^3.6 | WASM サポート |
| vite-plugin-top-level-await | ^1.6 | トップレベル await のサポート |

## スクリーンショット機能

スクリーンショットは以下のタイミングで取得されます。

- 定期取得 (間隔は設定可能)
- フォーカス喪失時 (window blur)
- 手動操作

ストレージ: IndexedDB + SHA-256 ハッシュ検証
エクスポート: ZIP 内 `screenshots/` ディレクトリ + `manifest.json`
