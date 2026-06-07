# examples

ADR-0006 試験モードの**プレビュー/staging 動作確認用**サンプル。実際の試験問題ではない。

## preview-sample.tcexam

封印問題パッケージ（`.tcexam`）のサンプル。出題者鍵 `exam-202606-preview`（`packages/shared/src/examAuthorityKeys/registry.ts` に公開鍵を登録済み）で署名されている。

| 項目 | 値 |
|---|---|
| examId | `2026-preview-demo` |
| problemId | `p1` |
| 監督コード | `TEST-2026`（入力時の区切り/大小は無視される） |
| packageHash | `9f1095d914fe9febfb786deb51f0e7b647979af29e3839637de8e37e65630a9a` |
| release / deadline | 2026-01-01 〜 2027-01-01（advisory） |

### 使い方（プレビューで受験フローを確認）

1. プレビュー URL（このPRに CI がコメント）の editor を開く。試験モードで入る場合は URL に `?exam=1` を付ける。
2. `ExamStartGate`（全画面）で `preview-sample.tcexam` を取り込み、監督コード **`TEST-2026`** を入力 → 開始。
3. 署名検証 → 復号が通り、問題が表示される。タイプしてから問題パネルの「ログをダウンロード」で証明 ZIP を取得。
4. その ZIP を `/verify`（同プレビューの検証アプリ）に投入 → exam 束縛カードで root 束縛を確認。「問題パッケージを読み込む」で `preview-sample.tcexam` を渡すと署名/packageHash/内容まで完全検証。

> この鍵は検証用で、秘密鍵は maintainer がローカル保管している。過去 proof を束縛していないため、検証が済めば registry のエントリは安全に削除できる（本番鍵は append-only で残す）。
