# packages/shared — AGENTS.md

`@typedcode/shared` は **暗号証明エンジンと型定義の単一ソース**。editor / verify / verify-cli / workers がすべて依存する。

このファイルには、毎回読む責務・不変条件・罠だけを置く。理由・例外・表・一覧は [docs/](docs/) にあるので、下の「触る前に読む」で当たる文書を、コードを触る前に読む (置き場の規則は root の [AGENTS.md](../../AGENTS.md)「ドキュメント階層」)。

## 責務と境界

- **持つ**: ハッシュチェーン、PoSW、署名済みチェックポイントの payload 構築、検証ロジック、すべての公開型、フィンガープリント生成
- **持たない**: DOM API への依存、IndexedDB、Monaco、Worker (Cloudflare Workers / Web Worker) の固有 API。ブラウザと Node 両方で動く前提

## 触る前に読む

| 触るもの | 先に読む |
|---|---|
| 下の不変条件に関わるコード (ハッシュチェーン・PoSW・版のゲート・ZIP の展開・鍵の判定・分析器・仕様別の検証) | [docs/invariants.md](docs/invariants.md) の同じ番号 |
| どのモジュールが何を持つか、新しいモジュールの置き場 | [docs/modules.md](docs/modules.md) |

## 重要な不変条件 (壊さないこと)

長い項目は見出しと最初の文だけを置いてある。全文 (理由・例外・回帰テスト) の正本は [docs/invariants.md](docs/invariants.md) の同じ番号で、関わるコードを触る前に読む。番号は変えない (コード・テスト・他の文書が番号で参照する)。足す・変えるときは、全文を docs/invariants.md に書き、ここには見出しを 1 行だけ置く。

1. **ハッシュチェーン**: `h_i = SHA-256(h_{i-1} || JSON(event_i) || PoSW_i)`。JSON シリアライズはキー順序を決定的にする (`hashUtils.ts:deterministicStringify`)。**順序が崩れると既存の証明がすべて検証不能になる**
2. **PoSW 反復数**: `POSW_ITERATIONS` ([`src/version.ts`](src/version.ts)) 固定。検証側もこの値を期待する。**変更は破壊的**で、proof format version bump が必要。反復数は [ADR-0045](../../docs/adr/0045-lower-posw-iterations-for-recording-throughput.md) で 10,000 → 1,000 に下げると決め、proof・署名 cp・token の 3 系統の分岐とあわせて #810 の新仕様で実装する (#611 を #810 に畳んだ。proof の版 1.3.0 は作らない。[ADR-0053](../../docs/adr/0053-versioned-verification-contracts.md) §5)
3. **InputType の許可/禁止リスト**: `InputTypeValidator.ts` の `ALLOWED_INPUT_TYPES` / `PROHIBITED_INPUT_TYPES` がピュアタイピング判定の唯一の真実。新しい入力タイプを追加する際は判断を ADR に残す ([docs/adr/0005-input-type-policy.md](../../docs/adr/0005-input-type-policy.md))
4. **`PROOF_FORMAT_VERSION`**: 既存 proof との互換性ある変更なら据え置き。互換性破壊なら bump 必須。検証器は `verifyProofFile` の入口で `proof.version` を `classifyProofVersion` (厳密 parse) で分類する (#223): 下限未満・不正形式は reject、既知 major を超えるものは reject せず `versionStatus: 'newer'` の warning。**proof の version を bump するときは、旧検証器が `newer` warning を出す前提で意味の変わる変更かどうかを判断し、`MIN_SUPPORTED_VERSION` / `EXAM_*_VERSION` の扱いを同じ PR で決める**。仕様別の入口 `verifyProofBySpec` は版を静的な registry への完全一致で識別し、registry に版を足すときはその版の凍結 fixture と検証器を同じ PR で足す (#809 / ADR-0053)
7. **anchored root 式の二重定義を一致させる** (ADR-0017): casual/class の anchored root は `computeAnchoredChainRoot` (verifier) と `HashChainManager.generateAnchoredInitialHash` (editor) の **2 箇所**に `SHA256(fp ‖ localNonce ‖ serverNonce)` を持つ。exam の `computeExamChainRoot`/`generateExamInitialHash` と同じ轍。式を変えるなら両方＋テストを同時に直す
5. **`CheckpointManager`** はステートフル。`shouldCreateCheckpoint` の判定は最終 cp の eventIndex / 時刻に依存する。`setCheckpoints` で復元する際は内部状態も再構築すること (実装済み)
6. **検証は cp の間隔を仮定しない**: `verify` 側は cp の存在を補助メタデータとしてのみ扱い、未署名 cp の sampling は信頼しない ([docs/adr/0004-verifier-checkpoint-stance.md](../../docs/adr/0004-verifier-checkpoint-stance.md))
8. **`isPureTyping` の判定点は 1 つ** (#235): `structuralEdit.ts` の `evaluatePureTyping` だけが決める。export 時の自己申告 (`TypingProof`) と採点側の再計算 (`verifyProofMetadata`) が同じ関数を呼ぶので、proof に焼かれる値と検証器の結論が食い違わない。**別の場所に式を書き足さないこと**。なお `metadata.bulkInsertEvents` は `isSuspiciousBulkInsert` の素のカウントのままで、こちらは申告値との完全一致を要求するので定義を変えると既存 proof が invalid になる
9. **ZIP エントリの展開は予算経由** (#234): `fileProcessing/zipBudget.ts` の `ZipExtractionBudget` + `readZipEntryBytes` / `readZipEntryText` だけが JSZip からバイトを取り出す
10. **registry の日時判定は 1 箇所** (#233): `checkpointKeys/keyValidity.ts` の `checkRegistryKeyValidityAt` だけが `validFrom` / `validUntil` / `revokedAt` を解釈する
11. **proof 由来の自己申告文字列は表示前に allowlist へ落とす** (#210 / #248): `proof.json` は攻撃者が組み立てられる入力で、型注釈は `JSON.parse` の結果を cast しただけ
12. **分析器はハッシュ対象のフィールドしか見ない** (#328): `description` / `insertLength` / `selectedText` などはハッシュに入らず、proof.json を書き換えても検証が通る
13. **token の検証失敗は改ざんではなく時刻アンカーの失敗** (#329): `verifyInitialHashRoot` は token の未登録 keyId・署名不正・`fingerprintHash` の不一致で `valid:false` を返さない
14. **分析器の失敗は signal にせず `analyzerStatus` に出す** (#301): `runAnalysis` は throw (同期・非同期)・期限切れ・契約に合わない出力を、その分析器の `analyzerStatus` に `failed` / `timeout` / `invalid-output` として残し、他の分析器を止めない
15. **仕様別の結果は自由文を読まず、legacy より甘くしない** (#809): `specs/legacyTypingProof.ts` は `FullVerificationResult` の構造化フィールド (`chainFailure`・`typingProofHashValid`・`eventMetadataValid`・`rootAnchorFailure.code`) と各検証の `keyStatus` だけから検査と鍵の信頼を写す
16. **鍵の環境は署名の検証の後で判定する** (#321 / ADR-0002): `registry.ts` のエントリは `environment` (`production` / `staging`) が必須 (型と `registryFormat.test.ts`)

## 型定義の運用

- `types/` 配下にカテゴリ別 (`events.ts`, `proof.ts`, `storage.ts`, ...) で配置
- ルート `types.ts` がすべて re-export
- **新しいイベント / 入力タイプを追加するときは `types/events.ts` だけでなく AGENTS.md / system-spec.md / shared README も同時更新**。過去にこの同期が崩れて事故った (#222: `VALID_EVENT_TYPES` が 26 種のまま union の 29 種から取り残された)
- `InputTypeValidator.ts` の `VALID_EVENT_TYPES` / `VALID_INPUT_TYPES` は **union から導出済み**なので手動同期は不要 — `EventType` / `InputType` に型を足すと **tsc が記入漏れを検出**する (#235 と同じ「文書ルールでなく機械で強制する」方針)

## テスト規約 (#4 テスト強化の方針)

- テスト名は **「何を保証するか」を 1 文の英語で書く** (例: `"first event never time-fires"`, `"setCheckpoints rebuilds trigger state from the restored array"`)。テスト名が実行可能な仕様になる
- 不変条件を 1 つテストするごとに 1 ケース。複数の主張を 1 ケースに詰めない
- 純粋関数は実体を直接使う (モックしない)。`HashChainManager` のような副作用のないクラスはそのまま `new` する
- 時計や乱数は注入可能にする (`now: () => number` パターン)。`CheckpointManager` 参照
- 新規モジュール追加時は `__tests__/<module>Trigger.test.ts` のように **対象モジュール名 + 観点** で命名
- 検証系のテストが何を保証し何を観測しないか (fast / full、MockWorker の偽 PoSW、凍結 fixture、既知の除外) は [docs/assurance-map.md](../../docs/assurance-map.md) にまとめる

### テストの基準値

- 現在は **全 green** (件数は書かない。実数は `npm run test:run -w @typedcode/shared` の出力が正本)。かつて happy-dom の `localStorage.clear` 未実装で `fingerprint.test.ts` が 20 件失敗していたが、上流のバージョン更新で解消済み。fingerprint テストが失敗したら、まず happy-dom のバージョンを疑う (回帰かどうかの切り分け基準)

## よくある罠

- **`shared` の `main` は `src/index.ts` (raw TypeScript)**: Vite と esbuild はそのまま読める。verify-cli は esbuild で shared ごと単一 ESM に bundle しているので `dist/cli.js` は素の node で動く (#298)。**tsc の emit を verify-cli の配布物にしないこと** (`.js` 拡張子 import が未生成の `.js` を指して ERR_MODULE_NOT_FOUND になる)
- **`SignedCheckpointService` (editor 側) は単一フライト**: shared 側で並列 `flush` を許す形に変えると、サーバ側の冪等判定とともに二重署名問題が再発しうる
- **PoSW の記録側と検証側は実装が違う** (#267): 記録側 (`PoswManager` / `poswWorker.ts`) は `await crypto.subtle.digest` の反復、検証側 (`verifyPoSW`) は同期の `iterateSha256HexSync`。各反復の入力は**前回ハッシュの小文字 16 進文字列の UTF-8 (= ASCII)** で、生バイトではない。どちらかの手順を変えると既存 proof の PoSW がすべて fail する。記録側の反復を await で回すか同期で回すかは、出力が同じなら形式にも安全性にも影響しない ([ADR-0045](../../docs/adr/0045-lower-posw-iterations-for-recording-throughput.md)。偽造の下限を決めるのは反復数と攻撃者側の最速の実装)。同期化するなら Worker の中だけにし、`PoswManager.computePoSWMainThread` (メインスレッドへのフォールバック) は同期にしない (UI が止まる)
- **`registry.ts` は append-only**: 鍵を消すと過去の proof が検証不能になる。失効するときは `status: 'revoked'` で残す
