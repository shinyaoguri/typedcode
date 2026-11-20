# packages/workers — KV のキーと容量

KV のキー・session record の形・台帳、容量の見積もりと枯渇時の挙動を触るときに読む。[AGENTS.md](../AGENTS.md) から移した節。

## KV ネームスペース

session record のキーは **`session:{sessionId}:{tabId}`** (タブ毎)。`checkpointIndex` はタブ毎に 0 始まりで sessionId はブラウザセッション共有のため、sessionId だけでキーイングすると複数タブ (class の N 問タブ等) で 2 枚目以降が衝突して 1 つも署名されない。verifier は `firstSeenAt` をタブ間で共有要求しない (proof = 1 タブ) ので per-tab で安全。

| Binding | キー | 内容 | TTL |
|---|---|---|---|
| `CHECKPOINT_SESSIONS` | `session:{sessionId}:{tabId}` | session record: `firstSeenAt`, `lastCheckpointIndex`, `lastServerTimestamp`, `signedCount`, `lastEnvelope` (冪等用) | 7 日 |
| `CHECKPOINT_SESSIONS` | `tabs:{sessionId}` | per-session タブ台帳 (`string[]`、ADR-0027 のタブ上限用) | 7 日 |

**キーの不変条件 (#297)**:

- キーは `checkpoint.ts` の `sessionRecordKey` / `tabRegistryKey` だけが組み立てる。**レコード種別ごとに接頭辞を分ける** (かつて台帳を `session:{sessionId}:tabs` に置いていたため、tabId=`tabs` の record と同じキーになり、後続タブの署名が例外になった)。新しい種別を足すときも別接頭辞にすること
- `sessionId` / `tabId` は shared の `validateSignedCheckpointInput` / `validateSessionStartInput` が **`^[A-Za-z0-9._-]+$` (≤200 文字)** に限る。区切り `:` を締め出すので `a:b`/`c` と `a`/`b:c` が同じ record キーに潰れない。ASCII 限定なので KV キーのバイト長上限 (512) にも収まる。editor の ID は `crypto.randomUUID()` なので常に集合内。2 つの validator の文字種は**同じ集合に揃える** (ずれると token は発行できるが署名できない sessionId が生まれる)
- KV の `get<T>('json')` は cast するだけなので、読んだ値は `isSessionRecord` / `isTabRegistry` で形を確かめる。不正形の **record は 503 `SESSION_STATE_UNAVAILABLE`** (null 扱いにすると別 `firstSeenAt` で署名する #151 の罠)、不正形の **台帳は read 失敗と同じ扱い** (cap 判定をスキップして署名は通す)
- **record キーは変えない**: 変えると進行中セッションが新しい `firstSeenAt` で署名され、editor の #151 ガードで署名が止まる

**移行 (#297 の台帳キー変更)**: 旧台帳 `session:{sessionId}:tabs` は読まれなくなり、TTL 7 日で自然消滅する。デプロイ直後の進行中セッションは台帳が空から数え直しになるが、cap が一時的に甘くなる側にしか倒れないので特別な移行作業は不要。record キーは据え置きなので署名の継続性 (`firstSeenAt`・冪等再送) には影響しない。

**firstSeenAt の分裂 (#151)**: KV は結果整合で他コロへの伝播に最大 ~60 秒かかる。cp 周期 (~10s) 内にコロ切替 (モバイル網等) が起きると、切替先では `existing=null` と誤認して**別の `firstSeenAt`** で署名しうる。verifier は全 envelope の firstSeenAt 完全一致を要求するため、そのまま proof に載ると正直な提出が丸ごと fail する。**緩和はクライアント側** — editor の `SignedCheckpointService` が既知の firstSeenAt と食い違う envelope を破棄してバックオフ再送する (伝播後のリトライは正しい値で署名される)。恒久対策 (Durable Object での per-session 逐次化) は W5 の ADR 課題。

### KV の容量見積もりと枯渇時の挙動 (#330)

**授業・試験で使う環境 (staging / production とも) は Workers Paid が前提**。Free の KV write は 1 日 1,000 回で、40 人の授業なら開始から数分で尽きる。KV を使う API は `/api/checkpoint/sign` だけ (`/api/session/start` と `/api/verify-captcha` は KV に触れない)。

**1 リクエストあたりの KV 操作** (`checkpoint.ts` の `handleSignCheckpoint`):

| 場面 | read | write | 根拠 |
|---|---|---|---|
| 2 回目以降の署名 | 1 (session record) | 1 (session record) | 冒頭の `CHECKPOINT_SESSIONS.get(sessionKey)` と、署名後の `put(sessionKey)` |
| タブの初回署名 (`isFirstCheckpoint`) | +1 (タブ台帳 `tabs:{sessionId}`) | +1 (台帳。そのタブが台帳に無いときだけ) | `get(tabsKey)` と `put(tabsKey)` |
| 冪等再送 / `NON_MONOTONIC` / `CHECKPOINT_CONFLICT` / `SESSION_LIMIT_EXCEEDED` | 1 | 0 | 署名と `put` の前に return する |
| token の不備 (401) | 0 | 0 | token 検証は KV read より前 (不変条件 7) |

**見積もりの式**: 1 人あたりの cp 数/分 `N = max(60 / MAX_CHECKPOINT_INTERVAL_S, イベント数/分 ÷ MAX_EVENTS_PER_CHECKPOINT)`。`MAX_*` は shared の `DEFAULT_MAX_CHECKPOINT_INTERVAL_MS` / `DEFAULT_MAX_EVENTS_PER_CHECKPOINT` ([ADR-0001](../../../docs/adr/0001-hybrid-checkpoint-trigger.md)。`CheckpointManager.shouldCreateCheckpoint`)。何も操作していない間は cp が出ないので 0 になる。現行の既定値では間隔側が 6 件/分、打鍵が 600 イベント/分を超えるとイベント側が支配する。

```
KV write ≈ 人数 × 分 × N + タブ数 × 1    (台帳の write)
KV read  ≈ 人数 × 分 × N + タブ数 × 1    (台帳の read) + 冪等再送・409 などの再送ぶん
```

例: 40 人 × 90 分 × 6 件/分 = 約 21,600 write (read もほぼ同数)。Free の 1 日 1,000 write は約 4 分で尽き、1 人あたりでも約 2.8 時間ぶんにしかならない。Paid なら月に含まれる 100 万 write の約 2% で、超過課金になっても write 分で 1 コマ約 $0.11。数字は上の式からの**机上の見積もり**で、負荷試験で確かめたものではない。

**Cloudflare の上限** (確認日 2026-11-01。出典: [KV limits](https://developers.cloudflare.com/kv/platform/limits/) / [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) / [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)。料金・上限は改定されうるので、判断の前に出典を見直すこと):

| | Free | Paid |
|---|---|---|
| KV read | 100,000/日 | 月 1,000 万を含み、超過は $0.50/100 万 |
| KV write | 1,000/日 (超えるとエラー) | 月 100 万を含み、超過は $5.00/100 万 |
| 同じキーへの write | 1 回/秒 | 1 回/秒 |
| Workers リクエスト | 100,000/日 (超えると Error 1027) | — |

**枯渇 (KV のエラー) 時の挙動** (read 失敗・初回の write 失敗・2 回目以降の write 失敗は `checkpoint.test.ts` のケースが押さえている。台帳の行はコード (`handleSignCheckpoint` の `try/catch`) からの読み取り):

| 枯渇するもの | 挙動 | クライアント |
|---|---|---|
| read (session record) | 全署名が 503 `SESSION_STATE_UNAVAILABLE` (初回に限らない)。署名しない | editor の `SignedCheckpointService` がバックオフ再送 |
| write、タブの初回 cp | 503 `SESSION_PERSIST_FAILED`。署名済み envelope は破棄 | 同上 (`firstSeenAt` が固定されるまで署名は成立しない) |
| write、2 回目以降 | **200 のまま** envelope を返す。record は更新されず (`lastCheckpointIndex` / `lastEnvelope` が古いまま)、次に書けた署名で追従する | 成功として扱う (失敗に気づかない) |
| read (タブ台帳) / write (台帳) | エラーにならない。台帳が読めなければタブ数の上限判定を飛ばし、書けなければ台帳が欠けて上限が甘くなる側にしか倒れない | 影響なし |

editor は署名を best-effort で扱い、export は `waitForFlush` が timeout で返るので止まらない。ただし署名待ちの cp は未署名のまま残る。write の枯渇後に始まるタブは初回 cp が 503 になって署名が付かない形で現れるので、授業・試験の前に Paid であることを確かめる。

Durable Objects 化 (ADR-0027 Option C) は `firstSeenAt` の分裂 (#151) の恒久対策として別に扱う。Paid であれば、容量を理由に急ぐものではない。
