# packages/shared — CLAUDE.md

`@typedcode/shared` は **暗号証明エンジンと型定義の単一ソース**。editor / verify / verify-cli / workers がすべて依存する。

## 責務と境界

- **持つ**: ハッシュチェーン、PoSW、署名済みチェックポイントの payload 構築、検証ロジック、すべての公開型、フィンガープリント生成
- **持たない**: DOM API への依存、IndexedDB、Monaco、Worker (Cloudflare Workers / Web Worker) の固有 API。ブラウザと Node 両方で動く前提

## 重要な不変条件 (壊さないこと)

1. **ハッシュチェーン**: `h_i = SHA-256(h_{i-1} || JSON(event_i) || PoSW_i)`。JSON シリアライズはキー順序を決定的にする (`hashUtils.ts:deterministicStringify`)。**順序が崩れると既存の証明がすべて検証不能になる**
2. **PoSW 反復数**: `POSW_ITERATIONS` ([`src/version.ts`](src/version.ts)) 固定。検証側もこの値を期待する。**変更は破壊的**で、proof format version bump が必要
3. **InputType の許可/禁止リスト**: `InputTypeValidator.ts` の `ALLOWED_INPUT_TYPES` / `BLOCKED_INPUT_TYPES` がピュアタイピング判定の唯一の真実。新しい入力タイプを追加する際は判断を ADR に残す ([docs/adr/0005-input-type-policy.md](../../docs/adr/0005-input-type-policy.md))
4. **`PROOF_FORMAT_VERSION`**: 既存 proof との互換性ある変更なら据え置き。互換性破壊なら bump 必須
5. **`CheckpointManager`** はステートフル。`shouldCreateCheckpoint` の判定は最終 cp の eventIndex / 時刻に依存する。`setCheckpoints` で復元する際は内部状態も再構築すること (実装済み)
6. **検証は cp の間隔を仮定しない**: `verify` 側は cp の存在を補助メタデータとしてのみ扱い、未署名 cp の sampling は信頼しない ([docs/adr/0004-verifier-checkpoint-stance.md](../../docs/adr/0004-verifier-checkpoint-stance.md))

## モジュール一覧

| モジュール | 役割 |
|---|---|
| `typingProof/TypingProof.ts` | ハッシュチェーンのファサード。エディタが使う |
| `typingProof/HashChainManager.ts` | SHA-256 計算とチェーン状態管理 |
| `typingProof/PoswManager.ts` | PoSW 計算 (Web Worker 経由) |
| `typingProof/CheckpointManager.ts` | ハイブリッドトリガ (N events OR T ms) で cp 作成 |
| `typingProof/ChainVerifier.ts` | full / sampling 検証 |
| `typingProof/InputTypeValidator.ts` | 許可/禁止 InputType の判定 |
| `typingProof/StatisticsCalculator.ts` | 統計計算 |
| `signedCheckpoints.ts` | 署名済み cp の payload 構築・検証・冪等判定 |
| `checkpointKeys/registry.ts` | append-only 公開鍵レジストリ (本番鍵) |
| `checkpointKeys/localKeys.ts` | skip-worktree のローカル開発鍵置き場 |
| `fingerprint.ts` | ブラウザフィンガープリント |
| `verification.ts` | チェーン外検証ユーティリティ (content replay 等) |
| `poswWorker.ts` | PoSW Web Worker 本体 |
| `attestation.ts` | 人間認証クライアント |
| `fileProcessing/` | ZIP / JSON 解析 |
| `types.ts` (実体は `types/`) | 全公開型 |

## 型定義の運用

- `types/` 配下にカテゴリ別 (`events.ts`, `proof.ts`, `storage.ts`, ...) で配置
- ルート `types.ts` がすべて re-export
- **新しいイベント / 入力タイプを追加するときは `types/events.ts` だけでなく `InputTypeValidator.ts` と CLAUDE.md / system-spec.md / shared README も同時更新**。過去にこの同期が崩れて事故った

## テスト規約 (#4 テスト強化の方針)

- テスト名は **「何を保証するか」を 1 文の英語で書く** (例: `"first event never time-fires"`, `"setCheckpoints rebuilds trigger state from the restored array"`)。テスト名が実行可能な仕様になる
- 不変条件を 1 つテストするごとに 1 ケース。複数の主張を 1 ケースに詰めない
- 純粋関数は実体を直接使う (モックしない)。`HashChainManager` のような副作用のないクラスはそのまま `new` する
- 時計や乱数は注入可能にする (`now: () => number` パターン)。`CheckpointManager` 参照
- 新規モジュール追加時は `__tests__/<module>Trigger.test.ts` のように **対象モジュール名 + 観点** で命名

### 既知の不安定テスト

- `fingerprint.test.ts` の 20 件失敗は happy-dom の `localStorage.clear` 未実装が原因。**修正禁止** (上流の問題)。新規変更が起因していないか判断する際の基準値は「147 + N passing, 20 fingerprint failing」

## よくある罠

- **`shared` の `main` は `src/index.ts` (raw TypeScript)**: Vite はそのまま読めるが、tsc コンパイル後の verify-cli を `node` で直接実行すると ESM 解決でコケる。これは pre-existing で Node バージョンとは無関係
- **`SignedCheckpointService` (editor 側) は単一フライト**: shared 側で並列 `flush` を許す形に変えると、サーバ側の冪等判定とともに二重署名問題が再発しうる
- **`registry.ts` は append-only**: 鍵を消すと過去の proof が検証不能になる。失効するときは `status: 'revoked'` で残す
