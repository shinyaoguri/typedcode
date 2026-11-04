# frozen-proofs (凍結 proof)

過去に出回った proof を、現行の検証器が今も同じ結論で検証できるかを見る互換の検査用 fixture (#581)。
`../../frozenProofs.test.ts` が各 proof を full モード (PoSW を全件再計算) で検証し、結論を固定する。

## 作り直さない

**このディレクトリの proof・鍵・パッケージを作り直さないこと。**

記録側 (editor) と検証側は同じ shared の関数 (`deterministicStringify` / `computeAnchoredChainRoot` と
`generateAnchoredInitialHash` / `hashSignedCheckpointPayload` / `computeExamChainRoot` と `generateExamInitialHash`)
を使う。両側を同時に変えるとユニットテストはすべて緑のまま、出回っている proof だけが検証できなくなる。
fixture を作り直すと、その変化が新しい fixture に焼き込まれて検査の意味が無くなる。

`frozenProofs.test.ts` が落ちたら、fixture ではなく**検証器側が既存の proof を壊している**。直すのは検証器の
ほうで、壊すのが意図した変更なら `PROOF_FORMAT_VERSION` の bump と旧 version の扱い
([packages/shared/AGENTS.md](../../../../AGENTS.md) 不変条件 1・4・7) を同じ PR で決める。

新しい形の proof を足すときは、既存ファイルを上書きせず別名のファイルとして足し、下の表に追記する。

## 生成時の情報

| 項目 | 値 |
|---|---|
| 生成日 | 2026-11-04 (UTC) |
| 生成時のコミット | `05d3200` (main。`feat(shared): 受理ポリシーを整合性から分け、署名 cp の存在と最終署名を要求できるようにする (#578)`) |
| `PROOF_FORMAT_VERSION` | `1.2.0` |
| `POSW_ITERATIONS` | `10000` |
| `SIGNED_CHECKPOINT_FORMAT_VERSION` / `SESSION_TOKEN_FORMAT_VERSION` | `1` / `1` |
| `EXAM_PACKAGE_FORMAT_VERSION` / `EXAM_PROOF_VERSION` | `1` / `1` |

## 中身

| ファイル | 内容 |
|---|---|
| `casual-anchored.proof.json` | casual。`sessionStartToken` で root をサーバアンカー (ADR-0017)。29 イベント: #0 humanAttestation、打鍵 (insertText / insertLineBreak)、Backspace (deleteContentBackward)、外部貼り付け (externalInput の insertFromPaste + contentChange の insertReplacementText)、範囲選択して打ち替え (replaceContent)、preExportAttestation。署名 cp 3 個 (event 8 / 18 / 28 = 最終イベント) |
| `exam-v1.proof.json` / `exam-v1.tcexam.json` | exam v1 (単一問題、ADR-0006)。12 イベント: #0 humanAttestation (best-effort)、#1 examOpened、打鍵、Backspace、preExportAttestation。署名 cp なし (未署名の最終 cp 1 個) |
| `exam-v2.proof.json` / `exam-v2.tcexam.json` | exam v2 (N 問バンドル、`rootBinding: 'v2'`、ADR-0012)。2 問のバンドルの p1 に束縛。11 イベント: #0 humanAttestation (best-effort)、#1 examOpened、starter の templateInjection、replaceContent、打鍵、preExportAttestation。署名 cp 2 個 (event 5 / 10 = 最終イベント) |
| `checkpoint-key.json` | 署名 cp と sessionStartToken を署名したテスト鍵の公開鍵 (`CheckpointPublicKey`)。テストが registry に注入する |
| `exam-authority-key.json` | 2 つの `.tcexam` を署名したテスト出題者鍵の公開鍵 (`ExamAuthorityKey`)。テストが registry に注入する |
| `generate.mts` | 生成に使ったスクリプト (記録として残す。作り直しには使わない) |

- 秘密鍵は生成時に捨てており、どこにも残っていない。これらの公開鍵を本番の registry に足さないこと
- `.tcexam` の Argon2id は極小パラメータ (256 KiB / 1 iter) で封印している (テストの復号を速くするため。
  params は manifest に載って署名されるので、検証の手順は本番の既定値と変わらない)

## 生成手順 (記録)

```bash
npx tsx packages/shared/src/__tests__/fixtures/frozen-proofs/generate.mts
npx biome format --write packages/shared/src/__tests__/fixtures/frozen-proofs/
```

テスト鍵は実行のたびに新しく作られるので、再実行すると全ファイルが別物になる (= 作り直しになる)。
PoSW は本物を計算する (Node に Worker が無いので、PoswManager の main-thread fallback に落とす)。
