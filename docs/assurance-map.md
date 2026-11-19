# 保証と検査の対応表

proof が約束することごとに、仕様・判断の根拠、それを確かめる検査とその条件、**その検査が観測しないこと・既知の除外**を並べる (#691)。テストの数や緑であることだけからは保証の範囲を読めないので、ここで「何が緑なら何が言えるか」を辿れるようにする。

- **更新の規律**: 既知の除外・未観測の条件は、この文書の「観測しないこと・既知の除外」列だけに書き、「検査」列 (成功したテストが保証する範囲) には含めない。関連 Issue が閉じたら、この文書の該当行を直す (解消済みにする・検査列へ移す)。正本はこのファイル 1 か所
- 定数・アルゴリズム・テストの中身は写さない。正本は [system-spec.md](system-spec.md)・[ADR](adr/)・テスト自身で、ここからはリンクで指す
- テスト名は「ファイル」の後に `describe` / `it` / `test` の名前をそのまま書く (`grep` で引ける)。件数は書かない

## 読み方

「条件」列の略記は次のとおり。

| 略記 | 意味 |
|---|---|
| unit | ユニットテスト。`npm run test:coverage` (= `check:fast`・CI の test job) で走る |
| E2E | Playwright の E2E。`npm run test -w @typedcode/e2e` (= `check`・CI の e2e job) で走る。ブラウザは Chromium だけ (`packages/e2e/playwright.config.ts` の `projects`) |
| nightly | `@nightly` の E2E。PR ゲートには載らない (`NIGHTLY=1`。[packages/e2e/AGENTS.md](../packages/e2e/AGENTS.md)) |
| fast / full | 検証モード。fast は PoSW の反復を再計算しない ([system-spec §6.1](system-spec.md#61-3-検証モード)) |
| PoSW モック | shared のユニットは `src/__tests__/setup.ts` の `MockWorker` が偽の PoSW を返す。記録した proof は fast でしか通らない |
| PoSW 本物 | 反復を実際に計算した proof。E2E は記録側 (ブラウザの Worker) で本物を計算するが、verify-cli を fast で回す spec は再計算しない |
| 合成 | テストのコードで `TypingProof` に記録した proof、または手で組み立てたイベント列 |
| 実ブラウザ | 実エディタを打鍵して export した proof |
| 凍結 | 一度だけ生成してコミットした fixture。作り直さない ([fixtures/frozen-proofs/README.md](../packages/shared/src/__tests__/fixtures/frozen-proofs/README.md)) |
| 同時生成 | テストの実行のたびに作る proof |

検査が本当に壊れを捕まえるか (検証力) は、カバレッジでは測れない。新しい検査は壊して赤を見てから仕上げ ([ADR-0037](adr/0037-see-red-before-trusting-new-tests.md))、shared の検証系は `npm run mutate -w @typedcode/shared` で変異検査を回す ([ADR-0040](adr/0040-mutation-testing-with-stryker-locally.md))。

## 1. 編集列・最終内容の整合性

| 約束 | 仕様・根拠 | 検査 | 条件 | 観測しないこと・既知の除外 | 関連 Issue |
|---|---|---|---|---|---|
| 正規に記録した proof は検証に通る (正の対照) | [§6.3](system-spec.md#63-検証成功判定) | [verification.property.test.ts](../packages/shared/src/__tests__/verification.property.test.ts) `accepts every proof recorded from a generated editing session` | unit・fast・PoSW モック・合成・同時生成 | 生成する操作は挿入・削除・カーソル・フォーカスだけで、root アンカー・署名 cp・貼り付け・テンプレートを含まない (ファイル冒頭のコメント) | |
| 〃 | 〃 | [verificationRootAnchorAndPosw.test.ts](../packages/shared/src/__tests__/verificationRootAnchorAndPosw.test.ts) `accepts an untampered proof through verifyProofFile in full mode (positive control)` | unit・full・PoSW 本物・合成 | | |
| 〃 | 〃 | [happy-path.spec.ts](../packages/e2e/tests/happy-path.spec.ts) `casual: 打鍵→export→CLI 検証が pass する` | E2E・full・PoSW 本物・実ブラウザ。E2E で full はこの 1 本だけ ([packages/e2e/AGENTS.md](../packages/e2e/AGENTS.md) 不変条件 4) | | |
| ハッシュ・署名の対象を 1 つでも書き換えると、fast でも full でも拒否する | [§8.1](system-spec.md#81-強い保証-cryptographic-guarantees) | verification.property.test.ts の `verifyProofFile (fast) tamper detection properties (#595)` (1 フィールドの変更・入替・削除・複製・previousHash の付け替え) | unit・fast・PoSW モック・合成・同時生成 | ハッシュ対象外のフィールドは書き換えても `valid` が変わらない (§8.1 の列挙)。性質テストが改ざんするのはイベント列だけ | #677 (解消済み。§8.1 の記述) |
| 〃 | 〃 | [tamper-detection.spec.ts](../packages/e2e/tests/tamper-detection.spec.ts)・[proof-forgery.spec.ts](../packages/e2e/tests/proof-forgery.spec.ts) `export した proof への各種偽造を verify-cli がすべて拒否する` | E2E・fast・実ブラウザ | 試す偽造は spec に書いた種類だけ | |
| PoSW を計算せず一貫させて作り直した proof は、full だけが拒否する | [§8.2](system-spec.md#82-弱い保証-probabilistic--heuristic)・[ADR-0031](adr/0031-integrity-partial-when-posw-skipped.md) | verificationRootAnchorAndPosw.test.ts `makes verifyProofFile fail in full mode on the same tampered chain, reporting the PoSW error and the event index` と `does not fail the same tampered chain when PoSW recompute is skipped (fast mode), which shows only the PoSW check catches it` | unit・full / fast・PoSW 本物・合成 | **fast の成功は反復を実際に計算したことを示さない** (§8.2)。fast の proof を使う検査 (上の性質テスト・fast の E2E) はこの約束を支えない | #677 (解消済み) |
| 構造の壊れた proof にも throw せず `valid: false` と理由を返す | [§5.3](system-spec.md#53-proofjson-単一ファイル形式) の構造検証 | [eventStructureGate.test.ts](../packages/shared/src/__tests__/eventStructureGate.test.ts) `event array structure gate`・`inputType of the wrong type (#678)` | unit・fast・合成 | | #678 (解消済み。性質テストの差し替え値は型の合わない値も含み、型違いの `inputType` を `fc.pre` で除外していない) |
| 最終内容は記録列の再生と一致する | [§6.2](system-spec.md#62-検証-6-レイヤ) | [verification.positiveControls.test.ts](../packages/shared/src/__tests__/verification.positiveControls.test.ts) `verifyContentReplay: 置換・削除 (rangeLength > 0)` ほか | unit・合成 (手で組んだ列) | | |
| 〃 (操作の組み合わせ) | 〃 | [model-based.spec.ts](../packages/e2e/tests/model/model-based.spec.ts) の固定シードの 2 本 (タイトルの先頭が `model-pr-1`・`model-pr-2`。export の内容・名前・言語・Pure Typing をモデルと突き合わせる) | E2E・fast・PoSW 本物 (再計算なし)・実ブラウザ・同時生成。固定シード 2 本 (長尺のランダムシードは nightly の `model-nightly`) | 探索範囲はモデルの操作と観測の定義 ([editorModel.ts](../packages/e2e/tests/model/editorModel.ts))。打鍵の文字種と言語は内容を予測できる範囲に絞り、モードは casual だけ | #616 (§4 を参照) |
| verify Web と verify-cli は同じ proof に同じ結論を出す | [§6.3](system-spec.md#63-検証成功判定) | [webCliParity.test.ts](../packages/verify/src/services/__tests__/webCliParity.test.ts) `web ↔ CLI parity (#216)`・[verify-web-parity.spec.ts](../packages/e2e/tests/verify-web-parity.spec.ts) | unit・合成 / E2E・fast・実ブラウザ | success / warning・verified / partial の区別は Web だけの導出で比べない ([packages/e2e/AGENTS.md](../packages/e2e/AGENTS.md) 不変条件 6) | |

## 2. 時刻アンカーと受理ポリシー

受理ポリシーは整合性とは別の要求水準で、採点者が opt-in で足す ([ADR-0043](adr/0043-acceptance-policy-separated-from-integrity.md))。時刻の三層保証の語彙は [ADR-0020](adr/0020-three-layer-assurance-vocabulary.md)。

| 約束 | 仕様・根拠 | 検査 | 条件 | 観測しないこと・既知の除外 | 関連 Issue |
|---|---|---|---|---|---|
| token の検証に失敗しても改ざんとは言わず、root のアンカーの失敗として返す | [§6.3](system-spec.md#63-検証成功判定)・[ADR-0017](adr/0017-server-anchored-chain-root.md) | [verification.untrustedSessionToken.test.ts](../packages/shared/src/__tests__/verification.untrustedSessionToken.test.ts) `verifyProofFile: a session start token signed by a key outside the registry (#329)` ほか | unit・full・合成 | | |
| 署名 cp の並び・時刻・内容の食い違いを拒否する | [ADR-0002](adr/0002-signed-checkpoints-with-ecdsa-p256.md) | [signedCheckpointRejections.test.ts](../packages/shared/src/__tests__/signedCheckpointRejections.test.ts) | unit・合成 | | |
| まとめて後から署名したセッション (post-hoc) と疎な署名を見分ける | [§8.2](system-spec.md#82-弱い保証-probabilistic--heuristic)・[ADR-0016](adr/0016-anchoring-density-signal.md) | [signedCheckpointEventTime.test.ts](../packages/shared/src/__tests__/signedCheckpointEventTime.test.ts) `post-hoc batch signing measured on hashed event time (#320)`・[signedCheckpointThresholds.test.ts](../packages/shared/src/__tests__/signedCheckpointThresholds.test.ts) | unit・合成 | 主張する時刻と同じだけの実時間をかけた「ライブ台本セッション」は防げない (§8.2 の天井) | |
| 時刻の水準 `anchored` は、最終イベントまで署名され、token と cp の sessionId が一致するときだけ | [§6.3](system-spec.md#63-検証成功判定) | [assurance.unsignedTail.test.ts](../packages/shared/src/__tests__/assurance.unsignedTail.test.ts) `assurance for an anchored proof whose last events are not signed (#295)`・[assurance.test.ts](../packages/shared/src/__tests__/assurance.test.ts) | unit・fast・合成 | | |
| 〃 (過去の proof) | 〃 | [frozenProofs.test.ts](../packages/shared/src/__tests__/frozenProofs.test.ts) `still derives an anchored temporal level` | unit・full・PoSW 本物・凍結 | | |
| 受理ポリシーの違反と改ざんを混ぜない (整合性が落ちたらポリシーを評価しない) | [§6.3.1](system-spec.md#631-受理ポリシー-296-adr-0043) | [acceptancePolicy.test.ts](../packages/shared/src/__tests__/acceptancePolicy.test.ts) `evaluateAcceptancePolicy table (#296)`・`verifyProofFile on a tampered proof (#296)`・[cliAcceptancePolicy.test.ts](../packages/verify-cli/src/__tests__/cliAcceptancePolicy.test.ts) | unit・fast・合成 | | |
| ポリシーを立てたときだけ、実 proof が違反で exit 1 になる | 〃 | [verify-cli-strict.spec.ts](../packages/e2e/tests/verify-cli-strict.spec.ts)・[verify-cli-strict-sparse.spec.ts](../packages/e2e/tests/verify-cli-strict-sparse.spec.ts) | E2E・fast・実ブラウザ。署名はローカルの workers と setup が作るテスト鍵 | 「密な proof は exit 0」の正の対照は、1 打鍵ごとに PoSW の処理待ちが掃けるのを待って打つ (`helpers/strictPolicy.ts` の `typeAtRecordingPace`)。**遅い端末で速く打った正直な proof が `--require-anchor-density` を通ることは観測しない** | #684 (open。正当な入力に対する条件の決定待ち) |
| 署名・token の取得に失敗しても編集と export は止まらず、未アンカーの proof として検証に通る | [§6.3](system-spec.md#63-検証成功判定) | [fault-checkpoint-sign.spec.ts](../packages/e2e/tests/fault-checkpoint-sign.spec.ts)・[fault-session-start.spec.ts](../packages/e2e/tests/fault-session-start.spec.ts) | E2E・fast・実ブラウザ (Workers の API に障害を注入) | | |

## 3. 過去の proof 形式との互換性

| 約束 | 仕様・根拠 | 検査 | 条件 | 観測しないこと・既知の除外 | 関連 Issue |
|---|---|---|---|---|---|
| 出回っている proof を、現行の検証器が同じ結論で検証する | [packages/shared/AGENTS.md](../packages/shared/AGENTS.md) 不変条件 1・4・7 | [frozenProofs.test.ts](../packages/shared/src/__tests__/frozenProofs.test.ts) `frozen casual proof anchored by a session start token and signed checkpoints`・`frozen $name proof` (exam v1 / v2) | unit・full・PoSW 本物・凍結 | 凍結したのは生成した時点の形式だけ (版・反復数は [fixture の README](../packages/shared/src/__tests__/fixtures/frozen-proofs/README.md) の表)。落ちたら fixture ではなく検証器を直す | #611 (open。反復数を版で分けるとき、この fixture が旧い反復数の proof になる) |
| 受理する版の範囲 (下限未満・不正形式は拒否、未知の新 major は warning) | [§6.3](system-spec.md#63-検証成功判定) のバージョンゲート | [versionGate.test.ts](../packages/shared/src/__tests__/versionGate.test.ts) `verifyProofFile version gate (#223)`・verify-cli の [versionGate.test.ts](../packages/verify-cli/src/__tests__/versionGate.test.ts) `proof version gate (#223)`・verify-web-parity.spec.ts の #223 の 2 本 | shared: unit・fast・合成・同時生成 / verify-cli: unit・コミット済みの `fixtures/proofs/valid.json` (形式が変われば作り直す fixture で、凍結ではない。[packages/verify-cli/AGENTS.md](../packages/verify-cli/AGENTS.md)) / E2E・fast・実ブラウザ | どれも現行で作った proof の `version` 欄だけを書き換える (`keeps accepting proofs at every released format version (1.0.0 to 1.2.0)` など)。旧版の記録器が実際に出した proof ではない | |
| fingerprint components の旧形式 (17 キー) を受け付け続ける | [ADR-0044](adr/0044-fingerprint-collection-scope.md) | [fingerprintCompat.test.ts](../packages/shared/src/__tests__/fingerprintCompat.test.ts) `fingerprint components compatibility (#242)` | unit・fast・PoSW モック・合成 | | |

## 4. 保存・復旧・export のデータ保全

ローカル保存の形は [§5.1](system-spec.md#51-ローカルストレージ-実行中)、救出ファイルは [§5.4](system-spec.md#54-救出ファイル-typedcode-rescue2) と [ADR-0042](adr/0042-rescue-code-before-proof.md)。

| 約束 | 仕様・根拠 | 検査 | 条件 | 観測しないこと・既知の除外 | 関連 Issue |
|---|---|---|---|---|---|
| リロード (sessionStorage からの復元) をまたいでチェーンが切れない | §5.1 | [reload-recovery.spec.ts](../packages/e2e/tests/reload-recovery.spec.ts) `リロード後もセッションが復元され、チェーンが途切れず検証が pass する`・[editorModel.ts](../packages/e2e/tests/model/editorModel.ts) の手 `Reload` | E2E・fast・実ブラウザ | | |
| ブラウザのタブを閉じて IndexedDB から再開しても、root アンカーとチェーンが保たれる | §5.1 | [close-tab-recovery.spec.ts](../packages/e2e/tests/close-tab-recovery.spec.ts) `タブを閉じて復旧ダイアログから再開しても root アンカーが保持され検証が pass する`・`tabs レコードの currentHash が古くても、再開後のチェーンは切れず検証が pass する (#322)` | E2E・fast・実ブラウザ | | |
| 〃 (復元順・切替履歴の並び) | §5.1 | [restoreOrder.test.ts](../packages/editor/src/ui/tabs/__tests__/restoreOrder.test.ts) `resolveRestoreOrder`・[tabSwitchOrder.test.ts](../packages/editor/src/services/__tests__/tabSwitchOrder.test.ts) `sortTabSwitchesByAppendOrder` | unit・合成 | | |
| 〃 (操作の組み合わせ) | §5.1 | editorModel.ts の手 `CloseAndResume` (model-based.spec.ts で実行) | E2E・fast・実ブラウザ・固定シード 2 本 | **モデルは同期を待ってから閉じ、`tab-switches.json` の並びも見ない**。古い `currentHash`・空の `tabOrder`・切替履歴の並びの退行は、上の個別の検査だけが守り、この手の成功は支えない | #616 (open) |
| 処理待ちを残して閉じても、復元したバッファは証明の版になり、元のコードは捨てない | [§5.4](system-spec.md#54-救出ファイル-typedcode-rescue2)・ADR-0042 | [restoredContent.test.ts](../packages/editor/src/ui/tabs/__tests__/restoredContent.test.ts) `reconcileRestoredContent`・close-tab-recovery.spec.ts の `#413` の 3 本 | unit・合成 / E2E・fast・実ブラウザ | | |
| export はチェーンに載っていない内容を proof に焼かない (排出できなければ中止する) | §5.2 | [ProofExporter.drainConsistency.test.ts](../packages/editor/src/export/__tests__/ProofExporter.drainConsistency.test.ts) `ProofExporter.exportAllTabsAsZip drain consistency (#225)`・editorModel.ts の手 `ExportAllTabs` (同期を待たずに export) | unit・合成 / E2E・fast・実ブラウザ | | |
| 保存先が壊れても export できるか、救出でコードを持ち出せる (救出ファイルは証明ではない) | §5.4・ADR-0042 | [fault-storage.spec.ts](../packages/e2e/tests/fault-storage.spec.ts)・[fault-storage-abort.spec.ts](../packages/e2e/tests/fault-storage-abort.spec.ts)・[fault-storage-rescue.spec.ts](../packages/e2e/tests/fault-storage-rescue.spec.ts)・[rescueBundle.test.ts](../packages/editor/src/export/__tests__/rescueBundle.test.ts) `buildRescueBundle (#544)`・[RescueExporter.test.ts](../packages/editor/src/export/__tests__/RescueExporter.test.ts) | E2E・fast・実ブラウザ (IndexedDB に障害を注入) / unit・合成 | | |
