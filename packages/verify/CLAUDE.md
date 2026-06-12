# packages/verify — CLAUDE.md

`@typedcode/verify` は **エクスポート ZIP を独立に検証する Web アプリ**。エディタとは別ドメインでも動くべきで、検証はクライアント側で完結する。

## 責務と境界

- **持つ**: ファイル投入 (drag&drop / FSA API)、Worker 経由のチェーン検証、PoSW 検証、署名済み cp の検証、UI 表示 (タイムライン、チャート、信頼スコア)、差分表示
- **持たない**: イベント生成、proof の改変。**読み取り専用**

## 重要な不変条件

1. **検証は cp の間隔を仮定しない** ([docs/adr/0004-verifier-checkpoint-stance.md](../../docs/adr/0004-verifier-checkpoint-stance.md)): 33 イベントごとでも 100 イベントごとでも 1 cp しかなくても動かなくてはいけない。`shared` 側の `CHECKPOINT_INTERVAL` の値を hard-code しない
2. **未署名 cp の sampling を信頼しない**: 検証成功条件として「サンプリングで OK だった」だけでは不可。フルチェーン検証または署名済み cp の連結検証が前提 (PR #60 のハードニング)
3. **検証 (Web Worker) は決定的**: `workers/verificationWorker.ts` は同じ proof に対して常に同じ結果を返す。乱数 / 時刻 / ネットワーク状態に依存しない (Workers の attestation 検証のみネットワーク依存だが、結果は cache 可)
4. **マルチタブ proof はタブ毎に独立した `<name>_proof.json` を N 個**として扱い、各タブを個別に検証する (verify-cli は全件検証、verify(web) はタブごと)。`MultiFileExportedProof` / `isMultiFileProof()` 型は存在するが現状のエクスポート経路では未使用 (dead)
5. **i18n キーは型と同期**: `src/i18n/types.ts` の `VerifyTranslationKeys` に新規キーを追加しないと TS2353 が出る

## ディレクトリ一覧

| ディレクトリ | 役割 |
|---|---|
| `ui/` | `AppController`, `TabBar`, `ActivityBar`, `StatusBarUI`, `ResultPanel`, `Sidebar`, `TypingPatternCard`, `ChartEventSelector` |
| `ui/controllers/` | `VerificationController`, `TabController`, `FileController`, `FolderController`, `ChartController` |
| `state/` | `VerificationQueue`, `UIStateManager`, `VerifyTabManager`, `ChartState` |
| `charts/` | `TimelineChart`, `MouseChart`, `IntegratedChart`, `SeekbarController` (Chart.js) |
| `services/` | `FileSystemAccessService`, `FolderSyncManager`, `SyntaxHighlighter`, `TrustCalculator`, `DiffService`, `ChartPreferencesService` |
| `workers/` | `verificationWorker.ts` (Web Worker ベースの検証) |

## データフロー

```
File Selection (drag&drop / FSA API)
  → FileProcessor (JSON / ZIP)
  → 形式判定 (single / multi: タブ毎に独立 proof)
  → VerificationController → VerificationQueue
  → workers/verificationWorker.ts (Web Worker)
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

`TrustCalculator.calculate` は加減点スコアではなく **issue リスト** を組み立て、`determineLevel` で `failed`(error あり) / `partial`(warning あり) / `verified`(issue なし) に落とす。issue を上げる要素:

- **error**: metadata 不正、ハッシュチェーン不正、スクショ改竄、署名 cp が anchored だが invalid、exam 束縛失敗 (package 提供時)
- **warning**: 未アンカー (署名 cp なし)、post-hoc 一括署名疑い、**アンカー密度が疎 (ADR-0016, `signedCheckpointDensity.sparse`)**、**root 未サーバアンカー (ADR-0017, `!rootAnchored` かつ非 exam)**、非ピュアタイピング (ペースト/バルク挿入)、ソース不一致、attestation 検証失敗、`screenShareOptOut`、exam だが問題パッケージ未読込、スクショ欠損

`VerificationController.handleComplete` のタブ status 判定と **同じ軸** を見るので、両者を揃えて変更すること (タブが緑なのに信頼バッジが警告、のような不整合を避ける)。`component` を増やしたら `ResultPanel.getComponentLabel` にラベルも追加する。

## よくある罠

- **`finalChainHash` の検証は 2 段**: `proof.finalHash` が記録値、`verifyFinalChainHash` が再計算値。両者一致を確認する
- **File System Access API はブラウザ依存**: Chrome/Edge のみ。フォールバック (`<input type="file">`) を維持
- **チャートのズーム / パン状態は `ChartPreferencesService` で永続化**: 検証結果のリセット時にクリアするか、ユーザー設定として残すかの線引きに注意
- **マルチファイル proof の `tabSwitches`**: タブごとの最終ハッシュとつながっている。タブの順序を変えるとチェーンが切れる
- **試験束縛カード (ADR-0006)**: `proof.exam` がある proof は root 束縛を worker が runtime で検証済み (`verifyInitialHashRoot` の exam 分岐。worker は proofData 全体を受け取る)。完全束縛 (署名/復号/内容) は **`.tcexam` を「問題パッケージを読み込む」で取り込んだとき** `verifyExamBinding` で検証 → `VerificationQueue.reverifyWithManifest` で当該タブのみ再検証。result-card は**折りたたみ式** (`.result-card-content` は既定 `display:none`、ヘッダクリックで展開) なので、ボタンは展開後に現れる
