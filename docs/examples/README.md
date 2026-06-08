# examples

ADR-0006 試験モードの**動作確認 (e2e) 用**手順。配布する封印サンプルは置かない
（出題者公開鍵を本番 registry に commit しない方針のため。registry は実運用鍵のみ）。
各 maintainer が **dev 鍵で自分用の `.tcexam` を生成**して受験フローを確認する。

## 1. dev 出題者鍵を用意

```bash
# 公開鍵 + 秘密鍵 (ECDSA-P256 JWK) を生成
node packages/workers/scripts/generate-exam-authority-key.mjs
```

- 出力された**公開鍵**を `packages/shared/src/examAuthorityKeys/localKeys.ts` に登録し、
  `git update-index --skip-worktree` で隠す（dev 鍵を commit しない。本番鍵だけが `registry.ts`）。
- **秘密鍵 JWK** と `keyId` は次のステップで使う（commit しない）。

## 2. 封印問題パッケージ (`.tcexam`) を生成

```bash
echo '# 問題: 1 から N までの和を求めよ' > /tmp/problem.md

EXAM_SIGNING_KEY_JWK='{...秘密鍵JWK...}' EXAM_SIGNING_KEY_ID=<keyId> \
  node packages/workers/scripts/make-exam-package.mjs \
    --problem /tmp/problem.md --exam-id demo --problem-id p1 \
    --languages c,python --token TEST-2026 --out /tmp/p1.tcexam
```

監督コード（`--token`）は省略すると自動生成され、標準出力に表示される。

## 3. 受験フローを確認（path で試験モードに入る）

1. editor を試験モードで開く: dev は <http://localhost:5173/exam>、プレビューは
   `<preview-url>/exam`（モードは **URL パス `/exam`** で確定。ADR-0011 で `?exam=1` sticky を置換）。
2. `ExamStartGate`（全画面）で `/tmp/p1.tcexam` を取り込み、監督コード（手順 2 の値）を入力 → 開始。
3. 署名検証 → 復号が通り、問題が表示される。タイプしてから問題パネルの
   「ログをダウンロード」で証明 ZIP を取得。
4. その ZIP を `/verify` に投入 → exam 束縛カードで root 束縛を確認。
   「問題パッケージを読み込む」で `/tmp/p1.tcexam` を渡すと署名/packageHash/内容まで完全検証。

> dev 鍵は `localKeys.ts`（skip-worktree）にのみ置く。registry.ts は本番運用鍵のみを
> append-only で保持し、過去 proof の検証可能性を維持する。
