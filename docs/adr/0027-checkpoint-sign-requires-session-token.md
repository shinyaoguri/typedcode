# ADR-0027: /api/checkpoint/sign を sessionStartToken 前提にする (DO 化は据え置き)

- **Status**: Accepted
- **Date**: 2026-07-02
- **Deciders**: develop レビュー (2026-07 W5 / #136, #151)
- **PR / Commit**: #136 恒久対策 PR

## Context

`/api/checkpoint/sign` は Origin も Turnstile も session トークンも要求しない無認証エンドポイントで、1 リクエストごとに KV read 1 + ECDSA 署名 1 + KV write 1 を消費する (#136)。`sessionId` / `tabId` はクライアント任意文字列なので、**新規 sessionId を連打すると per-session 上限 (`SESSION_MAX_CHECKPOINTS`) を回避して KV write を増幅させる DoS** になる。Workers Free プランの KV write (1,000/日) を数分で枯渇させると、以降すべての正規ユーザーの初回 checkpoint が `SESSION_PERSIST_FAILED` (503) になり、プラットフォーム全体の時刻アンカリングが停止する。

暫定対応として Cloudflare Rate Limiting Rule の設定を運用チェックリスト化した (workers/CLAUDE.md) が、これはダッシュボード管理でリポジトリに証跡が残らず、環境追加のたびに手動設定が必要で、**攻撃者にコストを強制する構造でもない**。

隣接課題として #151 (KV 結果整合による `firstSeenAt` 分裂) がある。クライアント側緩和 (不一致 envelope の破棄 + バックオフ再送、PR #179) は済んでいるが、根本解は Durable Object での per-session 逐次化であり、ADR-0003 が却下した複雑性との再トレードオフ判断が残っていた。

前提: ADR-0017 の `/api/session/start` は Turnstile 検証を経て ECDSA-P256 署名の `sessionStartToken` を発行しており、トークンは **KV なしでステートレスに検証できる** (信頼アンカーは公開鍵 registry のみ)。

## Considered Options

### Option A: Rate Limiting Rule のみ (現状維持)
- Pros: コード変更なし。既に運用手順化済み。
- Cons: per-IP 制限は分散攻撃に弱い。設定漏れが構造的に起きうる (リポジトリ外)。正規利用の閾値調整が難しい。攻撃者に何のコストも強制しない。

### Option B (採用): sessionStartToken を sign の前提にする + per-session タブ上限
- sign リクエストに `sessionStartToken` を同送させ、**KV read より前に** ECDSA 検証 + `token.payload.sessionId === input.sessionId` を要求する。
- 新規 sessionId の作成コスト = Turnstile 1 回。per-session / per-tab 上限が実効化する。
- 残余ベクタ「1 token から tabId 連打」には per-session タブ台帳 (`session:{sessionId}:tabs`、上限 64) で蓋をする。
- Pros: 無認証リクエストに KV コストを一切払わない。ステートレス検証で Workers 側の状態追加は最小。攻撃コスト = Turnstile solve に転嫁。
- Cons: editor 側のトークン配線が必要。exam (session/start を通らない) に別途手当てが要る。デプロイ跨ぎの旧クライアントは一時的に署名劣化する。

### Option C: Durable Object での per-session 逐次化 (#151 の根本解を今やる)
- per-session DO が firstSeenAt / 単調性 / 冪等 / タブ数 / レートを強一貫で管理。#151 も #136 のカウンタ回避も同時に解決。
- Pros: KV 結果整合に起因する全問題 (firstSeenAt 分裂、タブ台帳の over-admission、冪等キャッシュの見えない窓) が消える。
- Cons: 実装・運用の複雑性が大きい (ADR-0003 で却下した理由は今も有効)。#151 はクライアント緩和 (PR #179) で実害が観測されておらず、移行に見合う証拠がまだ無い。wrangler 設定・課金モデル・e2e/dev 環境への影響も広い。

## Decision

**Option B を採用し、Option C (DO 化) は再評価条件つきで据え置く。**

トークンはステートレス検証できるため、DoS の入口 (無認証 KV write) を最小の状態追加で閉じられる。DO 化は「強一貫が必要だという実測証拠」が出てから行う:

**DO 化の再評価トリガ** (いずれかを観測したら Option C を起こす):
1. PR #179 の firstSeenAt 不一致破棄が staging/production ログで恒常的に発生する (クライアント緩和で吸収しきれない頻度)
2. タブ台帳の over-admission (KV 結果整合による同時開始タブのすり抜け) が実害を生む
3. per-session の厳密なレート/クォータ制御が必要になる

## 実装の要点

### Workers (`checkpoint.ts`)
- スキーマ検証直後・**KV read より前**にトークンを検証する。エラーコード: `TOKEN_REQUIRED` / `TOKEN_INVALID` / `TOKEN_SESSION_MISMATCH` (いずれも 401)。検証失敗の内部理由はログのみ (クライアントには固定文言)。
- 新規タブの初回署名時のみ `session:{sessionId}:tabs` を読み、`MAX_TABS_PER_SESSION` (64) 超過なら `TAB_LIMIT_EXCEEDED` (429)。台帳は best-effort (KV 障害時は cap 判定をスキップして正規ユーザーを締め出さない。欠けても under-count 側 = cap が甘くなる側にしか倒れない)。

### Editor
- `SignedCheckpointService` は `getSessionStartToken` でセッションレベルのトークンを毎回解決し、body に同送する。トークンが無い間は**送信せず待機** (401 の無駄打ちをしない)。`TOKEN_INVALID` / `TOKEN_SESSION_MISMATCH` は恒久失敗として署名を諦め queue を空にする (export の `waitForFlush` を空回りさせない)。
- casual / class / assignment: root アンカー時に取得済みの token (先頭タブの `TypingProof.sessionStartToken`) をタブ横断で流用する。
- **exam**: root は封印束縛 (ADR-0006) で session/start を通らないため、タブ生成/復元時に**非ブロッキング best-effort** で署名専用トークンを取得する (`TabManager.acquireSigningTokenBestEffort`)。UI は出さず、試験開始をブロックしない (ADR-0006 の絶対条件)。root には焼かず proof にも同梱しない。失敗時は署名なしで劣化 = オフライン exam と同等。

### 劣化モード (トークンが得られないセッション)
- session/start 不達で開始したセッション (root 未アンカー) は署名済み checkpoint も持たない。これは ADR-0017 の劣化系列と整合する: root がアンカーされていない proof の署名 cp は保証への寄与が限定的で、strict 運用 (`--require-root-anchor`) では元々弾かれる。verifier は署名 cp の不在を「補助情報なし」として扱う (既存挙動、ADR-0004)。
- デプロイ跨ぎ: 旧ビルドの editor で進行中のセッションはトークンを送らないため、リロードまで署名が失敗する (proof は valid のまま、anchored のみ欠落)。

## Consequences

### Positive
- 無認証リクエストは KV に一切触れず、ECDSA 検証 1 回で棄却される。KV write 増幅 DoS が「Turnstile solve × タブ上限 × per-session 上限」に有界化される。
- Rate Limiting Rule は defense-in-depth に降格し、設定漏れが即座に致命傷にならない。
- exam セッションが (ネットワークがあれば) これまで通り時刻アンカリングを得られる。

### Negative / Trade-offs
- タブ台帳は KV 結果整合の下で over-admission がありうる (厳密化は DO 化の仕事)。
- exam の署名可否が Turnstile 到達性に依存する (従来は sign 到達性のみ)。ベストエフォート追加取得で吸収。
- `MAX_TABS_PER_SESSION` (64) を超える正規ユースケース (巨大 class バンドル) が現れたら定数を再検討する。

### Follow-ups / 残課題
- DO 化の再評価トリガ (上記 3 条件) の観測を Workers Logs で行う (`[checkpoint] session token rejected` / firstSeenAt mismatch の頻度)。
- `createTabFromTemplate` のバンドルタブ非アンカー (ADR-0017 follow-up) は本 ADR の範囲外のまま。

## References

- `packages/workers/src/checkpoint.ts` (token 検証・タブ台帳)
- `packages/editor/src/services/SignedCheckpointService.ts` (送出ゲート・恒久失敗処理)
- `packages/editor/src/ui/tabs/TabManager.ts` (`findSigningToken` / `acquireSigningTokenBestEffort`)
- ADR-0003 (冪等署名リトライ・DO 却下), ADR-0004 (verifier の cp 姿勢), ADR-0006 (exam の可用性絶対条件), ADR-0017 (sessionStartToken)
- Issue #136, #151 / PR #179 (クライアント側 firstSeenAt 緩和)
