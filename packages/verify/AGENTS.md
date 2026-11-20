# packages/verify — AGENTS.md

`@typedcode/verify` は **エクスポート ZIP を独立に検証する Web アプリ**。エディタとは別ドメインでも動くべきで、検証はクライアント側で完結する。

このファイルには、毎回読む責務・不変条件・罠だけを置く。理由・例外・表・一覧は [docs/](docs/) にあるので、下の「触る前に読む」で当たる文書を、コードを触る前に読む (置き場の規則は root の [AGENTS.md](../../AGENTS.md)「ドキュメント階層」)。

## 責務と境界

- **持つ**: ファイル投入 (drag&drop / FSA API)、Worker 経由のチェーン検証、PoSW 検証、署名済み cp の検証、UI 表示 (タイムライン、チャート、信頼スコア)、差分表示
- **持たない**: イベント生成、proof の改変。**読み取り専用**

## 触る前に読む

| 触るもの | 先に読む |
|---|---|
| 下の不変条件に関わるコード (検証の合成・スクリーンショット・ZIP の読み出し・提出物の照合・フォルダ監視) | [docs/invariants.md](docs/invariants.md) の同じ番号 |
| どこに何があるか、投入から結果の表示までの流れ | [docs/architecture.md](docs/architecture.md) (ディレクトリ一覧・データフロー) |
| `data-*` 属性と、それを読む E2E | [docs/state-contract.md](docs/state-contract.md) |
| `state/VerificationQueue`、`TrustCalculator`、タブの status の決め方 | [docs/verification.md](docs/verification.md) |
| 結果パネルのカード (分析・三層保証・プロセス要約)、シークバー、チャートの配置 | [docs/result-ui.md](docs/result-ui.md) |

## 重要な不変条件

長い項目は見出しと最初の文だけを置いてある。全文 (理由・例外・回帰テスト) の正本は [docs/invariants.md](docs/invariants.md) の同じ番号で、関わるコードを触る前に読む。番号は変えない (コード・テスト・他の文書が番号で参照する)。足す・変えるときは、全文を docs/invariants.md に書き、ここには見出しを 1 行だけ置く。

1. **検証は cp の間隔を仮定しない** ([docs/adr/0004-verifier-checkpoint-stance.md](../../docs/adr/0004-verifier-checkpoint-stance.md)): 33 イベントごとでも 100 イベントごとでも 1 cp しかなくても動かなくてはいけない。`shared` 側の `CHECKPOINT_INTERVAL` の値を hard-code しない
2. **未署名 cp の sampling を信頼しない**: 検証成功条件として「サンプリングで OK だった」だけでは不可。フルチェーン検証または署名済み cp の連結検証が前提 (PR #60 のハードニング)
3. **検証 (Web Worker) は決定的**: `workers/verificationWorker.ts` は同じ proof に対して常に同じ結果を返す。乱数 / 時刻 / ネットワーク状態に依存しない。verify は Workers の `/api` を一切呼ばない (署名済み cp の公開鍵は shared の `checkpointKeys` レジストリに同梱。検証側で attestation の署名は照合しない)
4. **マルチタブ proof はタブ毎に独立した `<name>_proof.json` を N 個**として扱い、各タブを個別に検証する (verify-cli は全件検証、verify(web) はタブごと)
5. **i18n キーは型と同期**: `src/i18n/types.ts` の `VerifyTranslationKeys` に新規キーを追加しないと TS2353 が出る
6. **スクリーンショット判定は全軸を `shared` に委譲する** (#212 / #213): per-image は `checkScreenshotImage`、剥ぎ取り (`chainOnly`) は `countChainOnlyImageHashes`、チェーン側ハッシュ集合は `collectChainImageHashes`。web に判定式を書くと verify-cli と結論が食い違う (実際に `chainOnly` が web だけ欠落し、剥ぎ取りが沈黙していた)
7. **`chainImageHashes` は必須引数**: optional にすると渡し忘れが fail-open (チェーン裏付け検査が無効化され、画像と manifest をセットで差し替えた改竄を見逃す) になる。実際に ZIP 経路と結論が割れる事故が起きたので、型で封じてある
8. **入力の種類で「0 枚」と「未検査」を区別する**: ZIP とフォルダは**コンテナ**なので `screenshots/` が無ければ 0 枚 = 剥ぎ取り疑いを見る。proof.json 単体は検査対象が無いので `undefined` = 未検査として issue を上げない (verify-cli の `Screenshots: not checked` と同じ意味論)。両者を混同すると overclaim または誤検知になる
9. **JSZip の `.async(...)` を直接呼ばない** (#234): ZIP エントリの読み出しは shared の `readZipEntryBytes` / `readZipEntryText` に `ZipFileProcessor` が作った `ZipExtractionBudget` を渡して行う。`.async(...)` は申告サイズを無視して最後まで展開するので、サイズを詐称した ZIP で採点者のブラウザが OOM する。`services/__tests__/zipReadPolicy.test.ts` が直接呼び出しを機械的に禁止する (文書ルールだけだった #149 では 6 箇所まで再発した)
10. **拡張子 → 言語の表は shared の `LANGUAGE_MAP` が正本** (#278): `KNOWN_LANGUAGES` (= proof の `language` の allowlist の導出元。#248) もここから導出される。verify に表を書き起こさない。`services/fileUtils.ts` は shared の `getLanguageFromExtension` / `getFileType` / `isProofFilename` を再エクスポートするだけで、`isBinaryFile` だけ「画像は別経路で扱う」ため `isImageFile` 除外を重ねる。`services/__tests__/fileUtilsPolicy.test.ts` が表の再出現を機械的に禁止する
11. **proof の名前 (`*_proof.json` / `*_proof_N.json`, shared の `isProofExportFilename`) なのに読めないファイルは、plaintext / success として並べず error として残す** (#292)

12. **同梱ソースと `proof.content` の照合は shared の `matchSubmissionSources` に委譲する** (#293): `FileController` が登録した材料 (フォルダごとの proof・ソース・読めない proof) を、全ファイルが揃ってから `settleSubmission` で照合する (途中で判定すると、まだ読んでいないソースが「欠落」に見える。ZIP は `processFile` の末尾、フォルダは `FolderController` が読み込み後に呼ぶ)
13. **外部更新 (FSA フォルダ監視) は同じタブ ID での取り込み直し** (#695)。表示状態 (proofData・language・startTimestamp)・照合材料 (`proofs[]` / `unreadable[]` / `sources[]`)・検証結果を新しい内容の同じスナップショットに揃え、更新経路で状態を部分的に組み立てない (旧実装は status と結果だけを初期化して新しい rawData を検証に回し、古い本文と新しい検証結果を合成して表示していた)
14. **フォルダ監視の読み取り失敗は削除ではない** (#699)。`FolderSyncManager.traverseForComparison` は読み取りの失敗 (ディレクトリの `values()`・個別の `getFile()`) を握り潰さずに投げ、`checkForChanges` はその回の追加・変更・削除を一切確定せず前回のスナップショットを保って `onSyncError` を呼ぶ (読めなかったエントリを「消えた」と見ると、読み込み済みのタブ・検証結果が一覧から消える)

## データフロー

流れの図と各段の注記は [docs/architecture.md](docs/architecture.md)。**Worker 内で検証を再合成しないこと** (#211): 検証の合成は shared の `verifyProofFile` に一本化してあり、web と CLI の結論の一致は `services/__tests__/webCliParity.test.ts` (#216) が固定している。

## 状態契約 (data-* 属性)

E2E (`packages/e2e`) は判定を翻訳テキストや色クラスではなく、[docs/state-contract.md](docs/state-contract.md) の表に挙げる **data-\* 属性** で読む ([ADR-0034](../../docs/adr/0034-replace-manual-verification-with-automated-tests.md))。値はすべて生の enum (shared / TrustCalculator / VerificationController の値そのもの) で、翻訳しない。

- 全表と、属性を付ける・外す規則 (判定を表示していない間は付けない、`data-status` の出所、active の 4 か所の同期) は docs/state-contract.md にある。属性を足す・変えるときは表を同じ PR で直す
- **この契約 (要素・属性名・値域・「無い」の意味) を変えるときは、`packages/e2e` の E2E と同じ PR で変える**。片方だけ変えると E2E が赤になるか、もっと悪いと別の要素を読んで黙って通る。

## 信頼スコア (`TrustCalculator`)

`TrustCalculator` は加減点ではなく issue リストを組み立てる。`VerificationController.handleComplete` のタブ status 判定と **同じ軸** を見るので、両者を揃えて変更すること (タブが緑なのに信頼バッジが警告、のような不整合を避ける)。error 条件を増やすときは CLI 側も同時に見ること。issue の区分と全文は [docs/verification.md](docs/verification.md) (検証キューも同じ文書)。

## よくある罠

- **`finalChainHash` の検証は 2 段**: `proof.finalHash` が記録値、`verifyFinalChainHash` が再計算値。両者一致を確認する
- **File System Access API はブラウザ依存**: Chrome/Edge のみ。フォールバック (`<input type="file">`) を維持
- **チャートのズーム / パン状態は `ChartPreferencesService` で永続化**: 検証結果のリセット時にクリアするか、ユーザー設定として残すかの線引きに注意
- **`tab-switches.json` はチェーン外の平文サイドファイル**: 各タブの proof とは独立で、ハッシュ連鎖に入らず verify / verify-cli も読まない。順序や内容を変えても検証結果は変わらない (監査用の人間向け情報)
- **試験束縛カード (ADR-0006)**: `proof.exam` がある proof は root 束縛を worker が runtime で検証済み (`verifyInitialHashRoot` の exam 分岐。worker は proofData 全体を受け取る)。完全束縛 (署名/復号/内容) は **`.tcexam` を「問題パッケージを読み込む」で取り込んだとき** `verifyExamBinding` で検証 → `VerificationQueue.reverifyWithManifest` で当該タブのみ再検証 (proof はタブの `proofData` を渡す。キューは完了した proof を持っていない)。result-card は**折りたたみ式** (`.result-card-content` は既定 `display:none`、ヘッダクリックで展開) なので、ボタンは展開後に現れる。なお package 未提供 (root 束縛のみ) のカードは **warning (緑にしない) + 既定展開** にしてある (`examBindingCardStatus`。導線を畳みの中に隠さない。#281)
