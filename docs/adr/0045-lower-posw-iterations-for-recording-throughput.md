# ADR-0045: PoSW の反復数を 1,000 に下げ、記録が入力に追いつくようにする

- **Status**: Accepted (実装は #611)
- **Date**: 2026-11-05
- **Deciders**: @shinyaoguri
- **PR / Commit**: (#241 を閉じる PR)

## Context

PoSW (Proof of Sequential Work) は、各イベントの記録に SHA-256 の連続反復を課し、その結果をハッシュチェーンに焼く (system-spec §4.4)。反復数 `POSW_ITERATIONS` は 2026-05 の導入時から 10,000 で、根拠を書いた ADR は無かった。値は proof・署名チェックポイントの payload (`poswIterations`)・セッション開始トークンの payload の 3 系統に焼かれ、検証器が `=== 10000` を要求している。

PoSW は時間の証明ではない。高性能な CPU ほど速く回せるので、課せるのは 1 本のチェーンへの逐次コストだけになる (#231 で spec を直した)。時刻の保証は署名チェックポイント (ADR-0002) とサーバアンカーされた root (ADR-0017) が担い、PoSW が独自に効くのは署名を取れなかった proof に限られる。

2026-08 のレビュー (#241) で、このコストに見合う価値があるかが問われた。2026-11-01 にメンテナが次を決めた。

- 記録側の反復の実装 (await か同期か) は、形式にも安全性にも関係しない実装の細部として扱う
- root アンカーの有無で反復数を変える案は採らない
- 反復数 10,000 の据え置きを基本とする。ただし低性能端末を模した条件で記録側の backlog を測り、増え続けるなら据え置きではなく、反復数を下げるか記録側の同期化を選び直す

記録は 1 本のチェーンに直列で積まれ、PoSW を終えたイベントから確定する。処理が入力に追いつかなければ処理待ち (backlog) が伸び、export は排出待ち (`waitForQueueDrain`) で待たされる。掃ける前にタブを閉じたイベントは、救出 (ADR-0042) と復元時の保全 (#413) に頼ることになる。

## 測定

ベンチは `packages/e2e/tests/posw.bench.spec.ts` (`npm run bench:posw -w @typedcode/e2e`)。実エディタ (casual) を Playwright で開き、打鍵とマウス移動を一定のペースで 20 秒流して、`__tcTestSnapshot()` の `pendingCount` を 250ms ごとに読む。スループットは、遅延なしで 42 文字を打って backlog を作り、掃ける速さで測る。

- 環境: Apple M3 Max、macOS、headless Chromium 156.0.8078.4 (Playwright 1.64)、main `671cda0`、2026-11-05
- 1 文字の打鍵は keyDown・keyUp・contentChange・cursorPositionChange・selectionChange の 5 件になる。マウスは `MouseTracker` の間引きで最大 10 件/秒
- **CDP の `Emulation.setCPUThrottlingRate` は dedicated Worker に効かない**。ページに 4 倍を掛けても Worker の 10,000 反復は 37〜42 ms で変わらない (メインスレッドは 36〜40 ms → 143〜149 ms)。Worker のターゲットへ送ると `Operation is only supported for pages, not workers` で拒否される。そこで「4 倍相当」は、メインスレッドに CDP で 4 倍を掛け、PoSW の Worker には、1 リクエストの処理時間 d を測って応答前に 3d だけ busy-wait するラッパーを差し込んで模擬した (製品コードは変えない)。CPU の遅さに処理時間が比例するという仮定に立つ

### 反復 10,000 (現行)

| 入力 | 入力 (件/秒) | 1 倍: 20 秒後の backlog | 4 倍相当: 20 秒後の backlog | 4 倍相当: 止めてから掃けるまで |
|---|---|---|---|---|
| スループット (飽和) | — | **26.3 件/秒** | **7.2 件/秒** | — |
| 打鍵 2 文字/秒 | 9.3〜9.9 | 0 (最大 5) | **56 (増え続ける)** | 8.9 秒 |
| 打鍵 4 文字/秒 | 16.8〜19.4 | 0 (最大 5) | **211 (増え続ける)** | 35 秒 |
| マウス 10 件/秒 | 7.4〜8.5 | 0 (最大 1) | 16 (増え続ける) | 2.8 秒 |
| 打鍵 4 文字/秒 + マウス 10 件/秒 | 23.4〜26.7 | **35 (増え続ける)** | **352 (増え続ける)** | 65 秒 |

### 反復 1,000 (見積もり)

`BENCH_ITERATIONS=1000` で、Worker が受け取る反復数を書き換えて測った。

| 入力 | 入力 (件/秒) | 1 倍: 最大 backlog | 4 倍相当: 最大 backlog |
|---|---|---|---|
| スループット (飽和) | — | **231 件/秒** | **67.9 件/秒** |
| 打鍵 2 文字/秒 | 9.5〜9.9 | 5 | 4 |
| 打鍵 4 文字/秒 | 17.9〜19.4 | 5 | 5 |
| マウス 10 件/秒 | 8.1〜8.6 | 1 | 1 |
| 打鍵 4 文字/秒 + マウス 10 件/秒 | 24.4〜28.0 | 6 | 5 |

どの条件でも backlog は数件で頭打ちになり、止めてから 11ms 以内に掃けた。

### 経路ごとの 1 イベントあたりの反復の速さ (10,000 反復)

| 経路 | 環境 | ms / event |
|---|---|---|
| 記録側 Worker (`await crypto.subtle.digest` の反復) | headless Chromium 156、M3 Max | 39〜63 |
| 同じ Worker で同期の `iterateSha256HexSync` (`@noble/hashes`) | 同上 | 26〜32 |
| 検証側 `iterateSha256HexSync` | Node 24、M3 Max (2026-11-01 の測定、#241) | 9.3 |
| 同期の `node:crypto` (偽造側の下限の目安) | Node (2026-08-23 の測定、#241) | 4.3〜6.8 |

## Considered Options

### Option A: 反復数 10,000 を据え置く

- Pros: proof の形式も検証器も変えない
- Cons: 4 倍相当の端末では、ゆっくりした打鍵 (2 文字/秒) でも処理が追いつかない。手元の高性能機 (M3 Max) でも、打鍵とマウスが重なると追いつかない。backlog が伸びれば export の待ちが長くなり、掃ける前に閉じたイベントはチェーンに載らない。課題・試験の受講者の端末は、手元より遅いものが多い

### Option B: 反復数を下げる (10,000 → 1,000)

- Pros: 記録側の処理が約 9 倍になり、4 倍相当でも典型的な入力 (約 25 件/秒) の 2.5 倍以上の余裕がある。検証側の full も約 1/10 になる
- Cons: 3 系統 (proof / 署名 cp / token) で版を分け、既存の 10,000 反復の proof を検証し続ける改修が要る (#611)。偽造側の下限が 1/10 になる

### Option C: root アンカーの有無で反復数を変える

- Cons: オフラインのとき token を取らない動機を、攻撃者に与える (2026-11-01 に不採用を決定)

### Option D: 記録側の反復を Worker 内で同期化し、反復数は 10,000 のまま

- Pros: 形式を変えない。出力はビット単位で同じ (`__tests__/poswSync.test.ts`)
- Cons: ブラウザでは約 1.6 倍にとどまる (39〜63 → 26〜32 ms)。4 倍相当のスループットは約 11〜12 件/秒の見込みで、打鍵 4 文字/秒 (約 17〜19 件/秒) に足りない

## Decision

Option B を採り、`POSW_ITERATIONS` を 1,000 に下げる。実装 (3 系統の版の分岐、既存 proof の検証の維持、workers の署名、spec の値) は #611 で行う。それまでは 10,000 のまま記録・検証する。

決め手は、Option A と D では低性能端末で記録が入力に追いつかないこと。下げても失うものは小さい。PoSW は時間の証明ではなく、偽造側の下限は 10,000 反復でも 10,000 events で 1 分前後 (同期の native で 4.3〜6.8 ms/event) だった。1,000 反復では 5〜7 秒になるが、どちらも 90 分の試験や数日の提出期限に対して、防御として意味のある長さではない。時刻の保証は署名チェックポイントと root アンカーが担う。PoSW に残る役割は「チェーンを作り直すには、イベントの数だけ逐次の計算が要る」ことだけで、これは反復数を下げても変わらない。

### 記録側の反復の実装は形式・安全性に影響しない

偽造の下限を決めるのは、反復数と攻撃者側の最速の実装で、正直な記録側の速さではない。記録側の反復を await で回すか同期で回すかは、出力が同じである限り、proof の形式にも安全性にも影響しない実装の細部として扱う。同期化するなら PoSW の Worker の中だけにし、`PoswManager` のメインスレッドへのフォールバック (`computePoSWMainThread`) は同期にしない (UI が止まる)。

### 目安

記録側と検証側で別の目安を置く。#611 の実装と、今後 PoSW の経路を変える PR は、これを満たすことを確かめる。

- **記録側**: CPU 4 倍相当 (上の模擬) で、打鍵 4 文字/秒 + マウス 10 件/秒を 20 秒流したとき、backlog が増え続けない (`pendingEvery2s` が単調に伸びない)。スループットは入力の 2 倍以上を目安にする
- **検証側**: full で 1,000 events あたり、verify-cli (Node) で数秒、検証 Web (ブラウザの Worker) で 10 秒以内を目安にする。1,000 反復なら Node で約 1 秒、ブラウザで約 3 秒の見込み (上の 10,000 反復の値の 1/10)

## Consequences

### Positive

- 低性能端末でも、記録が入力に追いつく。export の排出待ちが短くなり、掃ける前に閉じて救出に回るイベントが減る
- 検証側の full が速くなり、採点者が多数の proof を回す待ちが短くなる。e2e の full 検証も軽くなる
- 反復数の根拠が、測定と手順つきで残る。端末や実装が変わったら、同じベンチで測り直せる

### Negative / Trade-offs

- 3 系統の版の分岐で検証器が複雑になる。旧い版の proof の検証は消せない
- 偽造側の下限が 1/10 になる (10,000 events で 1 分前後 → 数秒)。PoSW を防御の根拠として説明している箇所は、時間の証明と読めないように直す (system-spec §4.4、export の README。この ADR と同じ PR)
- 4 倍相当は模擬で、実際の低性能端末の値ではない。Worker の処理時間が CPU の遅さに比例するという仮定に立つ

### Follow-ups / 残課題

- #611: 反復数を 1,000 に下げ、proof・署名 cp・token の検証を版で分ける
- 1 打鍵あたり 5 件というイベント数そのものは変えていない。入力のペースがさらに上がる記録 (高頻度のイベントの追加) をするときは、ベンチで測り直す

## References

- `packages/shared/src/version.ts` の `POSW_ITERATIONS`
- 記録側: `packages/editor/src/workers/poswWorker.ts`、`packages/shared/src/typingProof/PoswManager.ts`
- 検証側: `packages/shared/src/verification.ts` (`verifyPoSW` / `verifyChain`)、`packages/shared/src/utils/hashUtils.ts` (`iterateSha256HexSync`)
- ベンチ: `packages/e2e/tests/posw.bench.spec.ts`
- ADR-0002 (署名チェックポイント)、ADR-0017 (サーバアンカーされた root)、ADR-0031 (fast 時の integrity)、ADR-0042 (救出)
- #241 (本判断。測定は https://github.com/shinyaoguri/typedcode/issues/241#issuecomment-6635767828)、#267 (検証側の同期化)、#231 (spec の並列化の誤り)、#611 (実装)
