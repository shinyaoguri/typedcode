# ADR-0047: Python (Pyodide) を専用の Worker で動かし、ターミナルの入力を SharedArrayBuffer で stdin に渡す

- **Status**: Accepted
- **Date**: 2026-11-07
- **Deciders**: @shinyaoguri
- **PR / Commit**: (#649 を閉じる PR)

## Context

editor の Python は、Pyodide をエディタのメインスレッドで動かしていた (`PythonExecutor`)。stdout / stderr は設定していたが、stdin は設定していなかった。そのため `input()` を呼ぶと、Pyodide の既定の stdin がブラウザの `prompt()` を呼ぶ。ダイアログには案内文も出ない (2026-11-07 に dev サーバで実測。引数は `undefined`)。C / C++ はターミナルに打った文字を stdin で受け取れる (`CTerminal.connectStdin`) ので、言語によって入力の体験が食い違っていた。

#648 では、問題に入出力例を持たせ、受講者が自分で実行して入力を打ち、出力を見比べる形にした。初学者向けの課題では Python が主に使われる見込みである。「ターミナルに入力を打つ」が Python で通じないと、この案内が成り立たない (#649)。

制約は 2 つある。

- Pyodide の stdin のコールバックは**同期で**文字列を返さなければならない。ターミナルの入力は非同期に届くので、メインスレッドのままでは待てない (待つとエディタ全体が止まる)
- 親ページは COOP `same-origin` / COEP `credentialless` で cross-origin isolated になっている (dev と preview は `vite.config.ts`、本番は `public/_headers`)。C / C++ の Wasmer のためのものなので、SharedArrayBuffer と `Atomics.wait` (Worker の中) は既に使える

あわせて、メインスレッドで動かしていたことで次も起きていた。

- Python の計算中はエディタが固まり、打鍵の記録と保存も止まる
- 停止は AbortSignal を立てるだけで、同期のループは止まらなかった (`_onAbort` のコメント「Full abort of Pyodide execution is not fully supported」)
- 60 秒のタイムアウトも Promise を reject するだけで、メインスレッドが塞がっている間は発火すらしない

## Considered Options

### Option A: `prompt()` のまま、案内文を渡す

- Pros: 変更が最小
- Cons: ターミナルに打つ体験にならない。入力が `terminalInput` に記録されない。固まる問題と止まらない問題は残る

### Option B: メインスレッドのまま、JSPI (`pyodide.ffi.run_sync`) で非同期の入力を待つ

- Pros: Worker との通信が要らない
- Cons: `builtins.input` を差し替える形になり、`sys.stdin.readline()` などの読み取りを覆えない。JSPI の可否がブラウザの版に依存する。固まる問題と止まらない問題は残る

### Option C: 専用の module Worker で Pyodide を動かし、stdin を SharedArrayBuffer と `Atomics.wait` で渡す

- Pros:
  - Worker の中なら同期で待てるので、`input()` も `sys.stdin` も同じ stdin の経路を通る
  - 入力はターミナルの既存の `connectStdin` 経路 (C と共通) で渡るので、`terminalInput` の記録もそのまま残る
  - 計算中もエディタが固まらない
  - 停止とタイムアウトは `terminate()` で確実に終わる
- Cons:
  - 停止・タイムアウトのたびに Worker を捨てるので、次の実行で Pyodide を初期化し直す (CDN の配信物はブラウザのキャッシュに載るので数秒)
  - Pyodide は stdin をエコーしないので、行の編集 (エコー・バックスペース・確定) をメイン側で持つ必要がある
  - 本番ビルドで Worker の解決が壊れうる (#364 と同じ種類の罠)

### Option D: Option C を opaque origin の sandbox iframe の中で動かす (ADR-0041 と同じ箱)

- Pros: 保存領域 (proof の IndexedDB) からも隔離できる
- Cons: opaque origin の iframe との間で SharedArrayBuffer を共有できるかを確かめる必要がある。runner と CSP の設計も要り、#649 の範囲を大きく超える。ADR-0041 が「同じ箱に入れるかは別 Issue で扱う」としていた論点で、入力の不具合とは独立に決められる

## Decision

**Option C を採る。** Pyodide を専用の module Worker (`executors/python/pythonWorker.ts`) で動かす。ターミナルの入力は、メイン側の行の編集を通して確定した行ごとに、SharedArrayBuffer の行チャネルで Worker へ渡す。決め手は 2 つある。

- `input()` と `sys.stdin` の両方を、C と同じターミナルの経路にそろえられるのは、同期で待てる Worker だけ
- 固まる問題と止まらない問題も、同じ変更で根から直る

opaque origin への隔離 (Option D) は、入力の不具合と独立に決められるので、#650 で扱う。

決めたことは次のとおり。

1. **stdin**
   - ターミナルから来る生の入力は、メイン側で 1 文字ずつ行の編集を通す
     - 印字可能な文字はエコーする
     - `\x7f` / `\b` は 1 文字消して `\b \b` をエコーする
     - `\r` / `\n` は改行をエコーして行を確定する
   - 貼り付けの塊 (`"3\r5\r"`) も 1 文字ずつ処理されるので、行に分かれる
   - Worker が読む前に確定した行 (先打ち) は、メイン側のキューに貯める。Worker が入力を求めた (`stdin-request`) ときだけチャネルに書く。要求と書き込みを 1 対 1 にし、計時の停止・再開と競合させないため
   - チャネルは文字列ではなくバイト列を運ぶ。Pyodide には `setStdin({ read })` で渡し、`stdin` オプション (行単位の読み手) は使わない。Pyodide 0.27 の `stdin` オプションには 2 つの挙動がある。改行で終わらない文字列には `\n` を足す。既定の autoEOF では、改行で終わらない断片の次の読み取りに EOF を差し込む。どちらも、チャネルの領域を超えて分割した長い行を壊す
   - `isatty` は付けない。stdin と stdout が tty でなければ、CPython の `input()` は案内文を stdout に書いて flush してから読む
2. **stdout / stderr**
   - Pyodide の `write` ハンドラで受け、UTF-8 を stream で復号して逐次送る
   - 行単位の `batched` は使わない。改行の無い出力 (`input("名前: ")` の案内文) が、CPython が読み取りの前に stdout を flush した時点で出るようにするため。改行のある出力は従来どおり行ごとに出る (dev で、30M 回のループの前の `print` が、ループの後の `print` の約 3 秒前に表示されることを確かめた)
3. **停止**: Worker を `terminate()` し、run を `aborted` で終える。次の実行で初期化し直す。初期化 (Pyodide の読み込み) の最中の停止では Worker を止めず、読み込みを続けさせる
4. **タイムアウト**: 上限は 60 秒のまま据え置く。**入力待ちの間は数えない** (Worker は待つ直前に入力待ちを知らせる)。受講者が考えながら打つ時間で打ち切らないため。超えたら `terminate()` して `timeout` を記録する

## Consequences

### Positive

- Python でも、ターミナルに入力を打って実行を確かめられる (#648 の前提)
- 打った入力が C と同じく `terminalInput` に記録される
- Python の計算中もエディタの打鍵・記録・保存が止まらない
- 停止とタイムアウトが、同期のループでも確実に効く。結果も `aborted` / `timeout` として記録される
- micropip でのパッケージの自動インストールが動くようになった。従来は `micropip` を読み込まずに `import micropip` していたので、インストールは失敗していたはず (Worker では `loadPackage('micropip')` してから入れる)

### Negative / Trade-offs

- 停止・タイムアウトの後の最初の実行は、Pyodide の初期化の分だけ遅い
- 同じ origin の Worker なので、Python のコードは proof の IndexedDB に届く (ADR-0041 の Option B の実測と同じ)。DOM・localStorage・`/author` の `#author-jwk` には届かなくなったので、メインスレッドで動かしていた前よりは狭い
- SharedArrayBuffer に依存する。cross-origin isolation (COOP / COEP) を外すと Python の入力が動かなくなる (C / C++ の Wasmer も同じ前提)。Worker に SharedArrayBuffer を渡すには、Worker のスクリプトの応答にも COOP / COEP が要る (いまは dev / preview の `headers` と `_headers` の `/*` が満たしている)
- 行の編集の `\b \b` は 1 カラム分しか消さない。全角文字をバックスペースで消すと、見た目に半分残りうる (確定する行のデータは正しい)
- 先打ちしたときは、次の `input()` の案内文が、打った行のエコーより後に出る (実際の端末の先打ちと同じ順序)

### Follow-ups / 残課題

- Python を opaque origin に隔離する (Option D) かどうかは #650 で扱う
- EOF (Ctrl+D) と、Ctrl+C での停止は入れていない
- 複数行をターミナルに貼ったときに `terminalInput` が行ごとに記録されない (`CTerminal` 側の不具合)。#648 で直す

## References

- `packages/editor/src/executors/python/PythonExecutor.ts` / `pythonWorker.ts` / `stdinChannel.ts`、`packages/editor/src/terminal/stdinLineDiscipline.ts` (#648 で C のターミナルの記録と共有するため terminal/ へ移した)
- `packages/editor/src/terminal/CTerminal.ts` (`connectStdin`)、`packages/editor/src/execution/CodeExecutionController.ts`
- [ADR-0041](0041-sandboxed-code-execution.md) (JS / TS の sandbox 実行。C / Python を同じ箱に入れる論点)
- [ADR-0021](0021-code-execution-result-capture.md) (実行結果の記録)
- #649、#648、#364 (本番ビルドでだけ壊れる Worker の解決)
