# ADR-0041: ユーザーの JS / TS を opaque origin の sandbox iframe 内の Worker で実行し、停止・タイムアウトで実行環境ごと終わらせる

- **Status**: Accepted
- **Date**: 2026-11-04
- **Deciders**: @shinyaoguri
- **PR / Commit**: (#290 を閉じる PR)

## Context

editor の JavaScript 実行 (`JavaScriptExecutor`) は、ユーザーのコードをエディタと同じ realm の `new AsyncFunction(...)` で動かしていた。TypeScript も transpile 後に同じ経路を通る。そのため次のことが起きていた (#290)。

- 停止は AbortSignal を立てるだけだった。ユーザーコードはこれを無視でき、停止後もタイマーの続きが出力と副作用を出して、結果は `success` で記録された。30 秒のタイムアウトも `Promise.race` 相当で reject するだけで、コードは走り続けた
- 同期の無限ループ (`for(;;){}`) がエディタのメインスレッドを止めた。打鍵の記録と保存も止まる
- 実行コードから親の DOM、localStorage、proof のイベントを持つ IndexedDB に届いた。`/author` では同じ document に秘密鍵の入力欄 `#author-jwk` があった
- 停止してすぐ再実行すると、古い run の `finally` が新しい run の状態を書き換え、新しい run を停止できなくなった

要件の第一はコードの保全である (#290 の 2026-09-09 の要件更新、#300)。実行の停止・タイムアウト・Worker の異常・大量出力のどれが起きても、エディタ・保存・記録・export を巻き込まない。専用アプリのインストールは前提にしない。

親ページは COOP / COEP (`credentialless`) で cross-origin isolated になっている。C / C++ の Wasmer は SharedArrayBuffer を使うので、これを崩せない。

## Considered Options

### Option A: 同じ realm のまま AbortSignal とタイムアウトを強化する

- Pros: 変更が小さい
- Cons: 協力しないコードは止まらない。同期ループはメインスレッドを止める。DOM と保存領域から隔離できない。#290 の受け入れ条件をどれも満たさない

### Option B: 親と同じ origin の Blob Worker で実行する

- Pros: `terminate()` で確実に止まる。メインスレッドが固まらない
- Cons: 同じ origin なので保存領域を隔離できない。COOP / COEP (credentialless) 下の Chromium で、親 origin の Blob Worker から `indexedDB.open()` が成功することを確かめた (#290 の 2026-10-19 のコメント)。proof のイベントを読み書きできてしまう

### Option C: opaque origin の sandbox iframe の中で Blob Worker を作り、そこで実行する

- Pros: `sandbox="allow-scripts"` (allow-same-origin なし) の iframe は opaque origin になる。その中で作った Worker の `indexedDB` は `SecurityError` になり、親 DOM・localStorage・`#author-jwk` に届かない。Worker 内の `for(;;){}` の間も親は 61ms で応答し、iframe を除去すれば Worker ごと止まる (同じ実測)。親の `crossOriginIsolated` は保たれる。HTML プレビュー (#318 の `BrowserPreviewPanel`) と同じ形にできる
- Cons: 親子の通信が postMessage になる。ユーザーコードと別 realm になるので、console の代替と行番号の補正を Worker の中に持つ必要がある

### Option D: 別ドメインで runner を配信する

- Pros: origin の分離が配信の層で確定する
- Cons: ドメインと配信の運用が増える。Option C で保存領域・DOM・鍵から隔離できることを実測済みなので、今は要らない。将来 Wasm のランタイム (C / Python) を同じ箱に入れるときに再検討する

## Decision

**Option C を採る**。実行ごとに `<iframe sandbox="allow-scripts" hidden srcdoc=runner>` を作る。runner は srcdoc の inline script で、親から実行要求を 1 回だけ受け取り、Blob Worker でコードを実行する。終了は常に iframe の除去で行い、ユーザーコードの協力を当てにしない。iframe の中で直接実行しないのは、同じプロセスで動く同期ループが親を固めうるためである。

実装は `packages/editor/src/executors/sandbox/` に置く。

- **sandbox トークン**: `allow-scripts` だけを付ける。**`allow-same-origin` は足さない**。足すと `allow-scripts` と組み合わさって親と同じ origin になり、保存領域・DOM に届くうえ sandbox 自体を外せる
- **CSP** (srcdoc の meta): `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'`
  - `'unsafe-inline'` は runner のため
  - `'unsafe-eval'` は Worker の中の AsyncFunction (top-level await) のため
  - `blob:` は Worker のため
  - `connect-src 'none'` で fetch / XHR / WebSocket による外部送信の経路を作らない (学習用途では要らない)
- **通信**
  - 親は `e.source === iframe.contentWindow` と、メッセージの形 `{type, runId, ...}` (フィールドの型を含む) を検査する。別の run のメッセージと形の違うメッセージは捨てる。runId は run ごとに `crypto.randomUUID()` で作る
  - Worker は起動時に受け取った MessagePort だけで runner に返す。ユーザーコードは port に触れないので、`postMessage` で結果を偽れない
- **完了の定義**: Node と同じにする。本体の async 関数が settle し、かつユーザーが張ったタイマー (setTimeout / setInterval) が残っていないときに完了とする
  - 止めない setInterval はタイムアウトで終わる
  - 未捕捉の例外 (本体・タイマーの callback・unhandledrejection) は stderr に出して、すぐ `failure` (exit 1) にする
  - 本体が決して settle しない Promise を待つだけのコードは、Node なら exit 13 になる。ここでは検出せずタイムアウトに任せる
- **結果** (ADR-0021 の outcome)
  - 停止 → `aborted`
  - `EXECUTION_TIMEOUT_MS` (30 秒) を超えた → `timeout` (この ADR で outcome に足した)
  - 出力予算を超えた → 打ち切りを stderr に一度だけ出して `error`
  - runner の準備応答が `RUNNER_READY_TIMEOUT_MS` (10 秒) のうちに来ない、iframe を作れない、Worker が error イベントで落ちた → `error`
- **出力予算**: `OUTPUT_BUDGET_CHARS` は stdout と stderr の合計で 1,000,000 文字。大量出力がエディタのメモリと、記録・保存の余地を奪わないようにする。判定の正本は親側に置く。Worker も文字数を数え、予算を 1 文字超えたところで送るのをやめる (親を溢れさせない)
- **行番号**: AsyncFunction が本体の前に足す行の数はエンジンが決める。Worker の起動時に、同じ形の関数で投げた例外の位置から実測して差し引く。エラーの行は `(at line N, column M)` の形で出し、エディタはこれを読んでマーカーを付ける
- **停止 → 再実行**: `CodeExecutionController` は run ごとに番号を持つ。状態の更新とターミナルへの出力は、自分が今の run のときだけ行う
- **E2E の短縮**: E2E はタイムアウトと出力予算を dev ビルド限定の `window.__tcExecLimits` で縮める。本番ビルドでは読まない (`import.meta.env.DEV` のガードごと除去される)

## Consequences

### Positive

- 停止・タイムアウト・出力予算の超過の後に、出力も副作用も出ない。同期の無限ループの間もエディタは応答して記録が進む
- 実行コードから親 DOM・IndexedDB・localStorage・ネットワーク・`/author` の秘密鍵に届かない
- 停止・タイムアウト・正常終了・実行時エラー・実行基盤の異常を、result イベントの outcome で区別できる
- 実行系の失敗はすべて outcome に落ちる。editor・保存・export には伝播しない

### Negative / Trade-offs

- 実行ごとに iframe と Worker を作るので、起動に数十 ms かかる
- Worker の中には DOM が無い (`document` / `window` / `alert` は使えない)。学習用のコンソール出力の範囲では問題にならない
- 出力は Worker の中でまとめて送る (8 KiB ごと、またはタイマーの 1 tick ごと)。同期ループの途中の出力は、まとまってから届く

### Follow-ups / 残課題

- **#411 (親ページに CSP を入れる) への注意**: srcdoc の iframe は親の CSP も継承する。親に CSP を入れるときは、runner の `blob:` Worker と `'unsafe-eval'` を塞がないこと (`worker-src blob:` と、runner の inline script を通す設定が要る)。塞ぐと JS / TS の実行が runner の準備応答なしの `error` になる
- C / C++ (Wasmer) と Python (Pyodide) は今回は対象外で、これまでどおり親の realm で動く。同じ箱に入れるかは Option D とあわせて別 Issue で扱う
- TypeScript の transpile 部は #208 で差し替える。実行の経路 (この ADR) は変えない

## References

- `packages/editor/src/executors/sandbox/` (`SandboxRunner.ts` / `runnerDocument.ts` / `workerSource.ts` / `protocol.ts` / `limits.ts`)
- `packages/editor/src/execution/CodeExecutionController.ts`: run 番号のガード、outcome の記録
- `packages/e2e/tests/code-execution.spec.ts`: 回帰テスト
- [ADR-0021](0021-code-execution-result-capture.md): 実行結果の記録 (この ADR で `timeout` を足した)
- #290 (この ADR の起点)、#300 (コードの保全)、#318 (HTML プレビューの sandbox)、#411 (CSP)、#208 (TypeScript 7)
