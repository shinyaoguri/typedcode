/**
 * README Template (Japanese)
 * Template for the README.ja.md file included in exported ZIP archives
 */

export interface ReadmeTemplateParams {
  timestamp: string;
  totalFiles: number;
  totalScreenshots: number;
  sourceFiles: string[];
  proofFiles: string[];
}

export function generateReadmeJa(params: ReadmeTemplateParams): string {
  const { timestamp, totalFiles, totalScreenshots, sourceFiles, proofFiles } = params;

  const sourceFilesList = sourceFiles.map(f => `- \`${f}\``).join('\n');
  const proofFilesList = proofFiles.map(f => `- \`${f}\``).join('\n');

  return `# TypedCode 証明アーカイブ

## 概要

このアーカイブには、TypedCodeからエクスポートされたタイピング証明データが含まれています。TypedCodeは、コードが人間によってタイプされたことを暗号学的に証明するために、すべての編集操作を記録するコードエディタです。

**生成日時:** ${timestamp}
**ソースファイル数:** ${totalFiles}
**スクリーンショット数:** ${totalScreenshots}

---

## アーカイブの内容

### ソースファイル
${sourceFilesList}

### 証明ファイル
${proofFilesList}

### スクリーンショット
- \`screenshots/\` - 定期的な画面キャプチャ
- \`screenshots/manifest.json\` - スクリーンショットのメタデータとハッシュマッピング

---

## ハッシュチェーンのアーキテクチャ

TypedCodeは、記録されたイベントの整合性を保証するために、暗号学的ハッシュチェーン（ブロックチェーンに類似）を使用しています。

### 仕組み

\`\`\`
Event[0] ─┐
          ├─► Hash[0] = SHA-256(Event[0] + PoSW[0])
          │
Event[1] ─┼─► Hash[1] = SHA-256(Event[1] + Hash[0] + PoSW[1])
          │
Event[2] ─┼─► Hash[2] = SHA-256(Event[2] + Hash[1] + PoSW[2])
          │
   ...    │
          │
Event[N] ─┴─► Hash[N] = SHA-256(Event[N] + Hash[N-1] + PoSW[N])
\`\`\`

各イベントのハッシュは以下に依存します：
1. **イベントデータ** - 実際の操作（キーストローク、カーソル移動など）
2. **前のハッシュ** - 直前のイベントのハッシュ
3. **Proof of Sequential Work (PoSW)** - 生成に時間がかかる計算証明

### なぜ改竄が困難なのか

| 攻撃シナリオ | 失敗する理由 |
|-------------|-------------|
| 単一イベントの改竄 | そのイベントのハッシュが変わり、以降すべてのハッシュが無効化 |
| イベントの挿入/削除 | チェーンの連続性が破壊される |
| チェーン全体の再計算 | PoSWにより計算コストが膨大 |
| タイムスタンプの偽造 | 隣接イベントやPoSWのタイミングと矛盾 |

---

## イベントタイプ一覧

ハッシュチェーンには以下のイベントが記録されます：

### 編集イベント
| イベントタイプ | 説明 |
|--------------|------|
| \`contentChange\` | テキストの挿入、削除、置換 |
| \`contentSnapshot\` | 定期的なコンテンツ全体のスナップショット |
| \`cursorPositionChange\` | カーソル移動 |
| \`selectionChange\` | テキスト選択範囲の変更 |
| \`externalInput\` | ペーストまたはドロップ操作（フラグ付き） |

### 入力イベント
| イベントタイプ | 説明 |
|--------------|------|
| \`keyDown\` | キー押下（タイミングデータ付き） |
| \`keyUp\` | キー離上（押下時間付き） |

### 環境イベント
| イベントタイプ | 説明 |
|--------------|------|
| \`visibilityChange\` | タブの表示状態（アクティブ/非アクティブ） |
| \`focusChange\` | ウィンドウのフォーカス状態 |
| \`windowResize\` | ブラウザウィンドウサイズの変更 |
| \`networkStatusChange\` | オンライン/オフライン状態 |

### 画面キャプチャイベント
| イベントタイプ | 説明 |
|--------------|------|
| \`screenShareStart\` | 画面共有の開始 |
| \`screenShareStop\` | 画面共有の終了 |
| \`screenshotCapture\` | スクリーンショット撮影（ハッシュを記録） |

### 認証イベント
| イベントタイプ | 説明 |
|--------------|------|
| \`humanAttestation\` | Cloudflare Turnstileによる人間検証 |
| \`preExportAttestation\` | エクスポート前の検証 |
| \`termsAccepted\` | 利用規約への同意 |

---

## スクリーンショット検証

スクリーンショットは定期的にキャプチャされ、そのハッシュがチェーンに記録されます。

### キャプチャのトリガー
- **定期**: 60秒ごと
- **フォーカス喪失**: ウィンドウがフォーカスを失ってから5秒後
- **手動**: ユーザーによるトリガー（将来の機能）

### 保存形式
- **形式**: JPEG（60%品質）
- **場所**: ZIPファイル内の\`screenshots/\`フォルダ
- **命名規則**: \`screenshot_SEQUENCE_TIMESTAMP.jpg\`

### マニフェストファイル（\`screenshots/manifest.json\`）

マニフェストは、スクリーンショットファイルをハッシュチェーンのイベントに紐付けます：

\`\`\`json
[
  {
    "index": 0,
    "filename": "screenshot_000042_2025-01-15T10-30-00-000Z.jpg",
    "imageHash": "5f2a8c3d...",
    "captureType": "periodic",
    "eventSequence": 42,
    "timestamp": 123456.789,
    "createdAt": 1705312200000,
    "displayInfo": {
      "width": 1920,
      "height": 1080,
      "devicePixelRatio": 2,
      "displaySurface": "monitor"
    },
    "fileSizeBytes": 45678
  }
]
\`\`\`

### 検証プロセス

1. マニフェストファイルを読み込む
2. 各エントリについて：
   - \`filename\`で画像ファイルを特定
   - 画像のSHA-256ハッシュを計算
   - マニフェストの\`imageHash\`と比較
   - \`eventSequence\`で証明ログ内の対応するイベントを検索
   - イベントの\`data.imageHash\`が一致するか検証

---

## 証明ファイルの構造

各\`*_proof.json\`ファイルには以下が含まれます：

\`\`\`json
{
  "version": "3.x.x",
  "typingProofHash": "最終証明ハッシュ...",
  "typingProofData": {
    "finalContentHash": "コンテンツハッシュ...",
    "finalEventChainHash": "チェーンハッシュ...",
    "deviceId": "デバイスフィンガープリント...",
    "metadata": {
      "totalEvents": 1234,
      "pasteEvents": 0,
      "dropEvents": 0,
      "insertEvents": 500,
      "deleteEvents": 100,
      "totalTypingTime": 3600000,
      "averageTypingSpeed": 45.5
    }
  },
  "proof": {
    "totalEvents": 1234,
    "finalHash": "最終イベントハッシュ...",
    "startTime": 1705312200000,
    "endTime": 1705315800000,
    "signature": "HMAC署名...",
    "events": [
      {
        "sequence": 0,
        "timestamp": 0.0,
        "type": "humanAttestation",
        "hash": "イベント0のハッシュ...",
        "previousHash": null,
        "posw": {
          "iterations": 1000,
          "nonce": "ランダムノンス...",
          "intermediateHash": "...",
          "computeTimeMs": 50
        },
        "data": { ... }
      },
      ...
    ]
  },
  "fingerprint": {
    "hash": "デバイスハッシュ...",
    "components": { ... }
  },
  "metadata": {
    "userAgent": "...",
    "timestamp": "2025-01-15T10:30:00.000Z",
    "isPureTyping": true
  },
  "filename": "example.js",
  "content": "// ソースコード...",
  "language": "javascript"
}
\`\`\`

---

## 検証手順

### 手動検証

1. **ハッシュチェーンの整合性**
   - イベント#0から開始
   - 各イベントについて計算: \`SHA-256(event_data + previous_hash + posw)\`
   - 保存されている\`hash\`値と比較

2. **スクリーンショット検証**
   - 各画像ファイルのSHA-256を計算
   - マニフェストの\`imageHash\`と照合
   - 証明イベントの\`data.imageHash\`と照合

3. **コンテンツ検証**
   - すべての\`contentChange\`イベントを再生
   - 最終結果を\`content\`フィールドと比較

### 自動検証

TypedCodeの検証ページにアクセスし、証明JSONファイルをアップロードすると自動検証が行われます。

---

## セキュリティに関する考慮事項

### 証明できること
- コードが一文字ずつタイプされた（一括コピペではない）
- 編集が連続したセッション内で行われた
- セッション中に画面が共有されていた（スクリーンショットが証拠）
- 人間検証が実行された（Turnstile認証）

### 証明できないこと
- タイピングした人物の身元
- コードがオリジナルである（他から転記されていない）こと
- 外部からの支援が使用されていないこと

### プライバシーに関する注意
- すべてのデータはブラウザ内にローカル保存
- サーバーへの自動アップロードなし
- スクリーンショットはエクスポートしたZIPにのみ含まれる
- デバイスフィンガープリントはハッシュ化（復元不可）

---

## 技術仕様

| 項目 | 仕様 |
|-----|-----|
| ハッシュアルゴリズム | SHA-256 |
| PoSW反復回数 | 1000（設定可能） |
| スクリーンショット形式 | JPEG、60%品質 |
| スクリーンショット間隔 | 60秒 |
| フォーカス喪失遅延 | 5秒 |
| ストレージ | IndexedDB（ローカル） |

---

## ライセンス

この証明アーカイブはTypedCodeによって生成されました。
詳細は以下をご覧ください: https://github.com/sny/typedcode

---

*このREADMEはエクスポート時に自動生成されました。*
`;
}
