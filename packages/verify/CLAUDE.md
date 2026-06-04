# packages/verify — CLAUDE.md

`@typedcode/verify` は **エクスポート ZIP を独立に検証する Web アプリ**。エディタとは別ドメインでも動くべきで、検証はクライアント側で完結する。

## 責務と境界

- **持つ**: ファイル投入 (drag&drop / FSA API)、Worker 経由のチェーン検証、PoSW 検証、署名済み cp の検証、UI 表示 (タイムライン、チャート、信頼スコア)、差分表示
- **持たない**: イベント生成、proof の改変。**読み取り専用**

## 重要な不変条件

1. **検証は cp の間隔を仮定しない** ([docs/adr/0004-verifier-checkpoint-stance.md](../../docs/adr/0004-verifier-checkpoint-stance.md)): 33 イベントごとでも 100 イベントごとでも 1 cp しかなくても動かなくてはいけない。`shared` 側の `CHECKPOINT_INTERVAL` の値を hard-code しない
2. **未署名 cp の sampling を信頼しない**: 検証成功条件として「サンプリングで OK だった」だけでは不可。フルチェーン検証または署名済み cp の連結検証が前提 (PR #60 のハードニング)
3. **`VerificationEngine` は決定的**: 同じ proof に対して常に同じ結果を返す。乱数 / 時刻 / ネットワーク状態に依存しない (Workers の attestation 検証のみネットワーク依存だが、結果は cache 可)
4. **シングルファイルとマルチファイルを分岐**: `isMultiFileProof()` でディスパッチ。タブスイッチイベントの整合性検証を忘れない
5. **i18n キーは型と同期**: `src/i18n/types.ts` の `VerifyTranslationKeys` に新規キーを追加しないと TS2353 が出る

## ディレクトリ一覧

| ディレクトリ | 役割 |
|---|---|
| `core/` | `VerificationEngine`, `VerifyContext` |
| `ui/` | `AppController`, `TabBar`, `ActivityBar`, `StatusBar`, `ResultPanel`, `Sidebar`, `TypingPatternCard`, `ChartEventSelector` |
| `ui/controllers/` | `VerificationController`, `TabController`, `FileController`, `FolderController`, `ChartController` |
| `state/` | `VerificationQueue`, `UIStateManager`, `VerifyTabManager`, `ChartState` |
| `charts/` | `TimelineChart`, `MouseChart`, `IntegratedChart`, `SeekbarController` (Chart.js) |
| `services/` | `FileSystemAccessService`, `FolderSyncManager`, `SyntaxHighlighter`, `TrustCalculator`, `DiffService`, `ChartPreferencesService` |
| `workers/` | `verificationWorker.ts` (Web Worker ベースの検証) |

## データフロー

```
File Selection (drag&drop / FSA API)
  → FileProcessor (JSON / ZIP)
  → 形式判定 (single / multi)
  → VerificationEngine.verify()
  → VerificationQueue (Web Worker)
     ├─ sequence 連続性
     ├─ timestamp 単調性
     ├─ previousHash 検証
     ├─ ハッシュ再計算
     ├─ PoSW (POSW_ITERATIONS 反復)
     └─ 署名済み cp の連結検証 (任意)
  → AttestationService.verify() (Workers API)
  → ResultPanel + charts
```

## 信頼スコア (`TrustCalculator`)

`ResultPanel` で表示する信頼度の算定要素:

- **必須**: ハッシュチェーン有効、タイムスタンプ整合
- **加算**: ピュアタイピング、人間認証あり、署名済み cp あり
- **減算**: ペースト/ドロップあり、`screenShareOptOut` あり
- **注記のみ**: テンプレート注入

判定式を変えるときは UI 表示 (詳細展開) と `TypingPatternCard` の整合を確認すること。

## よくある罠

- **`finalChainHash` の検証は 2 段**: `proof.finalHash` が記録値、`verifyFinalChainHash` が再計算値。両者一致を確認する
- **File System Access API はブラウザ依存**: Chrome/Edge のみ。フォールバック (`<input type="file">`) を維持
- **チャートのズーム / パン状態は `ChartPreferencesService` で永続化**: 検証結果のリセット時にクリアするか、ユーザー設定として残すかの線引きに注意
- **マルチファイル proof の `tabSwitches`**: タブごとの最終ハッシュとつながっている。タブの順序を変えるとチェーンが切れる
