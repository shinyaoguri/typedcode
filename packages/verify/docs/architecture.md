# packages/verify — ディレクトリとデータフロー

どこに何があるかと、ファイルの投入から結果の表示までの流れ。[AGENTS.md](../AGENTS.md) から移した節。

## ディレクトリ一覧

| ディレクトリ | 役割 |
|---|---|
| `ui/` | `AppController`, `TabBar`, `ActivityBar`, `StatusBarUI`, `ResultPanel`, `Sidebar`, `AnalysisReportCard` (ADR-0009 の advisory 表示。打鍵動態の旧 `TypingPatternCard` はここに統合済み), `ProcessSummaryCard` (W3 プロセス要約), `ChartEventSelector` |
| `ui/controllers/` | `VerificationController`, `TabController`, `FileController`, `FolderController`, `ChartController` |
| `state/` | `VerificationQueue`, `UIStateManager`, `VerifyTabManager`, `ChartState` |
| `charts/` | `TimelineChart`, `MouseChart`, `IntegratedChart`, `SeekbarController` (Chart.js) |
| `services/` | `FileSystemAccessService`, `FolderSyncManager`, `SyntaxHighlighter`, `TrustCalculator`, `DiffService`, `ChartPreferencesService`, `proofVerification` (shared への委譲アダプタ + 総合判定 / 保証入力の写像) |
| `workers/` | `verificationWorker.ts` (Web Worker のメッセージ入出力のみ。検証は `services/proofVerification` へ) |

## データフロー

```
File Selection (drag&drop / FSA API)
  → FileProcessor (JSON / ZIP)
  → 形式判定 (single / multi: タブ毎に独立 proof)
  → VerificationController → VerificationQueue
  → workers/verificationWorker.ts (Web Worker。メッセージ入出力のみ)
  → services/proofVerification.runProofVerification
     ├─ verifyExamBinding (ADR-0006。package 提供時は**必ず**・verifyProofFile より前。
     │  #218: `proof.exam &&` を条件にすると exam ブロック無しの proof で束縛が黙って無効化される)
     ├─ shared の verifyProofFile (metadata / chain / PoSW / finalHash / content /
     │  checkpoint / 署名済み cp / sessionStartToken 突合 の合成は**すべて shared**)
     └─ runAnalysis (ADR-0009。advisory のみ・valid に不反映・失敗しても検証結果を落とさない)
  → VerificationController.handleComplete (タブ status を決める唯一の場所)
  → TabController.renderResult (TrustCalculator / deriveAssurance)
  → ResultPanel + charts
```

ネットワークには出ない (Workers の `/api` を呼ばない)。人間証明 (attestation) の `signature` は検証しない (検証 API は撤去済み。ADR-0017 / #340。export 前 attestation は #415 で署名自体をやめ、新しい proof は `'unsigned'`、旧 proof の HMAC 値は legacy として読むだけ)。

**Worker 内で検証を再合成しないこと** (#211)。過去にここでレイヤを組み直していたため、
`sessionStartToken` ↔ 署名 cp の sessionId 突合 (spec §6.3) が web だけ欠落し、`chainValid` に
署名 cp の失敗を畳み込んで整合性チップが誤って FAILED になっていた。web↔CLI の結論一致は
`services/__tests__/webCliParity.test.ts` (#216) が CI で固定する — verify-cli の `verifyProof` を
実際に呼んで `valid` / 三層保証 / exam 束縛 / スクショ集計 (tampered・chainOnly) を突き合わせるので、
片側だけ直すと落ちる。スクショの**読込経路** (ZIP vs フォルダ) の一致は `screenshotParity.test.ts` (#212) の担当。
