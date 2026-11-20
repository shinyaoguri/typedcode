# ADR-0056: Python (Pyodide) を opaque origin の sandbox iframe の中の Worker で実行し、記録の保存領域から隔離する

- **Status**: Accepted
- **Date**: 2026-11-20
- **Deciders**: @shinyaoguri
- **PR / Commit**: (#719 を閉じる PR。方式の決定と PoC の実測は #650)

## Context

ADR-0047 は Python (Pyodide) をメインスレッドから専用の module Worker へ移し、ターミナルの入力を SharedArrayBuffer (SAB) の行チャネルで stdin に渡した。Worker はエディタと同じ origin なので、DOM と localStorage には届かなくなったが、**proof の IndexedDB には届いた**。#719 は、実行コードから実セッションの `events` を readwrite で開けること、`js.eval` と任意の `fetch` が通ること、偽の完了メッセージで実行の結果を書き換えられることを再現した。

受講者が書いたコードは、記録そのものから見て信頼できない入力である。#650 (2026-11-12) で、実行コードを記録の origin から分離すると決めた。条件は次の 2 つ:

- `input()` / `sys.stdin` の同期読み (SAB と `Atomics.wait`。ADR-0047) を失わない。SAB の使えない構成へは移さない
- opaque origin で足りるなら、別 origin を用意しない小さい構成でよい

親のページは COOP `same-origin` + COEP `credentialless` で cross-origin isolated になっている。

## Considered Options

実測は Chromium 156 (Playwright 1.64.1。headless shell と本体の Chromium)、環境は dev・本番と同じヘッダを返す静的配信・`vite preview` の 3 つで、結果は同じだった (#650 のコメント)。

### Option A: 同じ origin の Worker のまま (ADR-0047 の現状)

- Pros: 変更が無い
- Cons: 実行コードから proof の IndexedDB に届く (#719 の再現)。採れない

### Option B: opaque origin の iframe に、親が作った SAB を渡す

- Pros: 親が stdin の書き手のままでよく、変更が小さい
- Cons: **本体の Chromium では `messageerror` になり、渡せない**。headless shell では届くが、仕様と違う挙動なので頼れない

### Option C: opaque origin の iframe の中で SAB を作り、親は入力の行を postMessage で渡す

`srcdoc` の iframe に `sandbox="allow-scripts"` (`allow-same-origin` は付けない) と `allow="cross-origin-isolated"` を付け、その中で Blob の classic Worker を起こして Pyodide を `importScripts` で読む。

- Pros: 別の origin も配信の変更も要らない。iframe と Worker の両方で `crossOriginIsolated` が `true` になり、SAB と `Atomics.wait` が使える。`indexedDB.open`・`indexedDB.databases()`・localStorage・`parent.document` は SecurityError で、親の行は実行の前後で変わらない。本体の Chromium では、opaque の srcdoc iframe は別プロセスになる
- Cons: `allow="cross-origin-isolated"` が無いと SAB が使えない (属性 1 つに依存する)。opaque origin の Blob からは module Worker を起動できないので、Worker のソースを文字列で持つ classic Worker になる。runner に cross-origin isolation を与えるので、実行コードは高精度のタイマーと SAB を持つ

### Option D: 別 origin の専用 runner

- Pros: 成り立つことは実測した (別サイト + COEP `credentialless` + CORP `cross-origin` + `allow`)
- Cons: ドメインと配信の運用が増える。Option C で足りる

## Decision

**Option C** を採る。

1. **構成**: Python は、親が作る hidden の iframe (`sandbox="allow-scripts"`・`allow="cross-origin-isolated"`・`srcdoc`) の中の classic Worker でだけ動く。**同じ origin で Python を動かす経路は製品コードに残さない** (`pythonWorker.ts` は削除)
2. **fail closed**: runner が cross-origin isolated でない・準備の応答が上限までに来ない・Worker が落ちた、のどれでも、iframe を除去してエラーで終える。同じ origin の Worker での実行へは戻さない
3. **stdin**: SAB は runner が作って Worker と共有する。親は、ターミナルが確定した行と EOF (#707 の `InteractiveStdin`) を postMessage で runner へ送る。親は SAB を持たない
4. **親から渡すもの**: コード・パッケージ名・stdin の行・出力の予算だけ。proof・sessionStartToken・鍵・DB 名は渡さない
5. **親が受け取るものの検査**: 送り手が runner の window (`e.source`) で、origin が `'null'` (opaque origin) であること。そのうえで、runner ごとの ID・run の番号・`type` の許可リスト・各フィールドの型と長さ (65,536 文字まで) を検査し、知っているフィールドだけを写す。**runner と Worker の中は実行コードの支配下にあるとみなす**: 親は、型と長さを通ったメッセージの中身を「実行コードの出力」として扱い、それ以上は信用しない (下の「既知の限界」)
6. **CSP と通信の権限** (runner の `meta`):

   ```
   default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob: <Pyodide の取得元>; worker-src blob:; connect-src <Pyodide の取得元> https://pypi.org https://files.pythonhosted.org
   ```

   `'unsafe-eval'` は付けない (`js.eval`・`run_js`・`Function` で runner の文脈のコードを作る経路を塞ぐ。Pyodide は無しで動く)。通信は、ランタイムの取得元と、既にある micropip の自動インストールが要る PyPI だけにする。**実行コードから、それ以外への通信は通らなくなる**。許可は 1 か所の定数から作り、足すときはこの ADR を更新する
7. **出力**: Worker がまとめて送り (8 KiB・16ms・入力待ちの前・終了の前)、親が JS / TS (ADR-0041) と同じ予算 (100 万文字) で打ち切る
8. **寿命**: ADR-0047 と同じ。初期化で runner を作って実行をまたいで保ち、停止・タイムアウト・異常・予算の超過で iframe を除去して、次の実行で作り直す

## Consequences

### Positive

- 実行コードから proof の IndexedDB・localStorage・親の DOM に届かない。#719 の再現 (列挙・open・読み書き・`js.eval`・任意の `fetch`・グローバルの `postMessage` での偽の完了) は、どれも止まる
- `input()` / `sys.stdin` の同期読み、日本語、複数行、EOF、停止と再実行は ADR-0047 のまま動く
- 無限ループ・初期化の失敗・大量の出力でも、親の記録・保存・export は止まらない
- 別の origin・配信の変更・追加のヘッダが要らない

### Negative / Trade-offs

- **runner の中のメッセージは偽装しうる**: 実行コードは Worker の中で Pyodide の FFI を使えるので、Worker と runner の間のポートを横取りして、自分の run の出力や完了の通知を作ることができる (CSP は eval を塞ぐが、既存の関数の差し替えまでは塞がない)。守っているのは「親の保存領域と DOM に届かないこと」で、「実行の結果が本物であること」ではない。実行の結果と出力は、もともと受講者のプログラムが決められる値なので、proof の信頼には使わない
- **PyPI への通信が開いている**: micropip のために許しているので、実行コードは `pypi.org` と `files.pythonhosted.org` へ GET を送れる (URL に情報を載せられる)。通信の方針は #723 で扱う
- **任意の外部通信ができなくなる**: 実行コードから外部の API を叩く演習は動かなくなる (利用者に見える変更)
- **実行コードが高精度のタイマーと SAB を持つ**: runner に cross-origin isolation を与えるため。本体の Chromium では runner が別プロセスになることを実測したが、ほかのブラウザのプロセス分離は確かめていない
- **Chromium 以外は未実測**: opaque origin の iframe に `allow="cross-origin-isolated"` で isolation が付かないブラウザでは、Python は fail closed でエラーになる。editor は Chromium 系以外を起動時に止める (#596 / ADR-0033) ので、対象外
- Worker のソースと stdin のチャネルを文字列定数で持つ (opaque origin の Blob から module Worker を起動できないため)。型検査が効かないので、ユニットテストは文字列を `vm` で動かして確かめる
- `=> 値` と traceback は出力の予算の外で、65,536 文字に切り詰める

### Follow-ups / 残課題

- C / C++ (Wasmer) は今回の対象外で、これまでどおり親の realm で動く。Wasmer の SDK は module Worker と自前の配信を使うので、同じ箱に入れるには別の検証が要る
- 親に CSP を入れるとき (#411) は、srcdoc が親の CSP を継承するので、runner の取得元と blob の Worker を塞がないこと
- 通信の権限 (PyPI) の扱いは #723
- Cloudflare Pages の本番 URL では確かめていない (本番と同じヘッダを返す手元の配信と、本番ビルドの `vite preview` で確かめた)

## References

- [ADR-0041](0041-sandboxed-code-execution.md) — JS / TS の opaque origin の sandbox (同じ考え方の先例。出力の予算)
- [ADR-0047](0047-python-in-dedicated-worker-with-terminal-stdin.md) — Python を専用の Worker で動かし、SAB で stdin を渡す (本 ADR は Worker の置き場所を改める)
- Issue #719 (実害の再現と受け入れ条件) / #650 (方式の決定と PoC の実測) / #707 (`InteractiveStdin`) / #723 (通信の方針) / #411 (本番の CSP)
- `packages/editor/src/executors/python/` — `PythonRunner.ts` (親の側)・`pythonRunnerDocument.ts` (srcdoc・CSP・属性)・`pythonRunnerWorkerSource.ts`・`pythonRunnerProtocol.ts` (検査)
- `packages/e2e/tests/python-isolation.spec.ts` — 隔離の回帰
