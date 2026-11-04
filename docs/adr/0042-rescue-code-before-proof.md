# ADR-0042: コードの保全を証明の正しさより優先し、証明ではない救出ファイルで持ち出させる

- **Status**: Accepted
- **Date**: 2026-11-04
- **Deciders**: @shinyaoguri
- **PR / Commit**: (#544 を閉じる PR。保存状態の区分は #543 = PR #553。段階 2 は #413 を閉じる PR)

## Context

TypedCode は打鍵をハッシュチェーンと PoSW に記録し、export で検証できる proof を出す。ところが export は、PoSW の排出待ち (`waitForQueueDrain`)・export 前の Turnstile・IndexedDB への flush・署名の待ちを通る。保存先 (IndexedDB / sessionStorage) が容量切れや transaction の abort で壊れる、Workers や Turnstile に届かない、PoSW の Worker が止まる、といった障害のどれかで、学習者は書いたコードを手元に持ち出せなくなりうる。

2026-09-09 にユーザーから「不正検知より、課題・試験で作成したコードが喪失せず、必ず後からログをダウンロードしてファイルを利用できることが最重要」と明示された (#300 の要件更新コメント)。要点は次の 3 つ。

- 証明の valid を守るためにコードを捨てない・古い内容に置き換えない
- 正常な証明の出力と、失敗時のデータ救出を別の経路にし、救出は認証・保存・排出待ちの成功を前提にしない
- 正常な提出物と救出用データを schema / manifest で区別し、救出用ファイルを valid と偽って表示しない

前段として、保存の失敗を `Synced` と表示していた問題を #543 で直した。同期状態は「PoSW の処理が済んだか」ではなく「永続化できたか」を表し、`synced` / `syncing` / `pending` に加えて `degraded` (IndexedDB と sessionStorage の片方にだけ保存できた) と `failed` (どちらにも保存できなかった) を出す。失敗した状態を学習者が見られるようになったので、その状態から確実にコードを持ち出す手段が要る。

## Considered Options

### Option A: 救出ファイルにも proof.json を同梱する

その時点のメモリ上のチェーンから `exportProof()` を作って `*_proof.json` として入れる。

- Pros: 救出ファイルが、そのまま検証にかけられる可能性がある
- Cons: `exportProof()` は最終 checkpoint を作り署名のフックを起こす (状態を変える)。PoSW 待ちのイベントが残っていると content replay が合わず invalid な proof になり、「救出したら不正扱いになった」と受け取られる。逆に検証に通ると、救出ファイルが正規の提出物と同じ顔をして流通する。#300 の「救出用ファイルを valid と偽って表示しない」に反する

### Option B: 救出も flush・排出待ちを通し、待ち時間に上限を付ける

通常の export と同じく `flushToIndexedDB` と `waitForQueueDrain` を待ち、上限で打ち切って出す。

- Pros: 救出ファイルの中身が、通常の export と同じだけ整合する
- Cons: 救出が要るのは、まさにそれらが壊れているときで、上限までの待ちが毎回乗る。flush や排出待ちの実装の新しいハング (#543 の abort のような) は、そのまま救出の停止になる。救出が何に依存するかを、待ちの上限の設計で守り続けることになる

### Option C: 救出はメモリ上の内容をそのまま読むだけにし、証明ではないことを形式で示す

待機・認証・保存・署名・スクリーンショットを一切呼ばず、エディタの内容とメモリ上のチェーンのイベントを読んで、`typedcode-rescue/1` の manifest を付けた ZIP (作れなければ単一 JSON、それも保存できなければソースを 1 つずつ) として出す。

- Pros: 救出の成功が、保存先・ネットワーク・PoSW・Turnstile のどれにも依存しない。読むだけなので状態を変えない。証明ではないことがファイル名・manifest・`*_proof.json` の不在の 3 点で分かる
- Cons: 救出ファイルは検証できない。PoSW 待ちのイベントはログに入らない (件数だけ manifest に残す)

## Decision

Option C を採る。救出はコードを手元に残すための経路で、証明を作る経路ではない。何も待たないことが救出の価値なので、Option A・B のように証明の経路の成功に寄せると、守りたい場面で救出がいっしょに止まる。

救出ファイルの形式 (`typedcode-rescue/1`。詳細は [system-spec §5.4](../system-spec.md))。

- ファイル名は `RESCUE_TC<YYMMDDHHmm>.zip`。通常の export (`ALL_TC…` / `<name>_TC…`) と取り違えない
- 中身は `src/<名前>` (エディタの内容。名前は通常の export と同じ `createExportNamer` の規則)、`logs/<名前>.events.json` (メモリ上のチェーンのイベント。検証していない記録)、`rescue-manifest.json`
- 「証明ではない」ことの表し方: `*_proof.json` を作らない。manifest に `notAProof: true` と注意書き (`notice`) を書く。ボタンの文言にも「証明なし / not a proof」を入れる
- manifest には、タブ別のチェーンのイベント数・IndexedDB への保存を確かめた数 (分からなければ `null`)・PoSW 待ちの数と、直近の保存の結果 (#543 の `idbOk` / `sessionStorageOk`) を書く。何が残っていて何が欠けたかを、受け取った人が読める
- 1 タブの読み出しが throw しても、他のタブは出す。イベントの読み出しだけが失敗したタブでも、ソースは出す
- ZIP が作れなければ単一 JSON (`{ manifest, files }`)、それも保存できなければソースを 1 ファイルずつダウンロードする

導線は左のダウンロードメニュー (`#rescue-download-btn`) と問題パネルのフッタ (`#problem-rescue-btn`)。exam は左のメニューを隠しているので、問題パネル側が要る。exam でも常に出す (試験中でも、保存が壊れればコードを持ち出す手段が要る)。

## Consequences

### Positive

- 保存先・Workers・Turnstile・PoSW のどれが壊れても、学習者はその時点のコードをファイルとして持ち出せる
- 救出ファイルが証明として流通しない (形式・名前・文言の 3 つで区別できる)
- 救出の組み立て (`buildRescueBundle`) は純関数で、入力 (`RescueTabSource`) の読み出しを関数にしてある。IndexedDB から読んだ過去のセッション (#317) からも同じ形で救出ファイルを作れる

### Negative / Trade-offs

- 救出ファイルは検証できない。提出の正本は、これまでどおり通常の export (証明) で、救出はその代わりにならない
- PoSW 待ちのイベントはログに入らない (件数だけ残る)
- ソースを 1 つずつ落とす最後の手段は、ブラウザの「複数のダウンロード」の許可を求められることがある

## 段階 2: 復元時に証明と食い違った元のコードを捨てない (#413)

段階 1 の救出は、エディタのバッファ (メモリ) を読む。ところが復元経路には、バッファに入る前にコードを捨てる箇所が残っていた。PoSW の処理待ちが残ったまま閉じる (またはリロードする) と、処理待ちの打鍵はチェーンに載らず、保存済みの content にだけ残る。処理待ちは復元しないので、復元時の `reconcileRestoredContent` (#142) は content を replay の結果まで切り詰め、元の content をどこにも残さなかった。直後の保存で tabs の content は上書きされ、警告も本番ビルドでは消えていた。救出 ZIP はバッファを読むので、切り詰めた後の版しか入らない。

2026-11-01 に案 A で確定した (#300 のコメント)。

- **バッファは replay 版にする** (#142 の目的 = 復元後の proof を content replay で invalid にしない、を保つ)。過去のイベントを捏造して帳尻を合わせる案 B (回復イベントを新設する) は採らない。proof 形式・検証器・分析器は変えない (`PROOF_FORMAT_VERSION` 据え置き)
- **元の content は IndexedDB の専用ストア `unprovenContents` に追記のみで残す**。tabs の行に欄を足すと、`saveTab` の put がその行ごと書き換えるので、上書きを防ぐ規律をコードの注意で守り続けることになる。別のストアにして put の経路を持たせないことで、上書きを構造で防ぐ。`clearSession` と `deleteTab` も触らない
- **知らせる**: 復元後に通知を出し、差分 (読み取り専用) と元のコードのダウンロードを開ける。差分の大きさは「末尾 N 文字」ではなく「元 X 文字 → 証明 Y 文字」で示す。処理待ちが途中の編集や削除だと、差分は末尾に限らず、元のほうが短いこともあるため
- **救出にも入れる**: 元のコードは救出 ZIP の `src/` (エディタの内容 = 証明と同じ版) とは別の `unproven/<n>/` に入れ、manifest のタブに `unprovenContents` (パスと文字数) を足す。形が変わるので schema を `typedcode-rescue/2` に上げる。救出は IndexedDB に依存しないという段階 1 の不変条件を保つため、保全した元のコードは復元のたびにタブのメモリ上の状態へ読み戻し、救出はそれを読む
- 元のコードをバッファへ自動で戻すことはしない (戻すと証明と食い違い、段階 2 の前と同じ invalid に戻る)。必要な部分は学習者が打ち直す

`STORAGE_FORMAT_VERSION` は据え置く。この定数は localStorage 用の整数で、IndexedDB のスキーマ (`SessionStorageService` の `DB_VERSION`) とは別に管理されている (`DB_VERSION` を 1 → 2 に上げたときも据え置いた)。今回の変更はストアを足すだけで既存の行の形を変えないので、移行は `onupgradeneeded` でのストア作成だけで足り、shared に移行関数は要らない。

形式は [system-spec §5.4.1](../system-spec.md)。

### Follow-ups / 残課題

- 過去のセッションを一覧から回収する導線 (#317)。救出ファイルを別のクリーンな環境で読み込んで使う導線
- 保全した元のコード (`unprovenContents`) の保持期間と容量の管理 (#317)。いまはモードのリセットで DB ごと消すまで残る
- 救出ファイルの読み込み側 (verify などで「証明ではない」と表示する) は未実装。いまは manifest を人が読む

## References

- `packages/editor/src/export/rescueBundle.ts` (`buildRescueBundle`)、`packages/editor/src/export/RescueExporter.ts`
- `packages/editor/src/ui/tabs/syncStatus.ts` (`resolveSyncStatus`。保存状態の区分 = #543)
- `packages/editor/src/ui/tabs/TabManager.ts` (`getPersistenceReport`、段階 2 の `restoreContent`)
- `packages/editor/src/ui/tabs/restoredContent.ts` (`reconcileRestoredContent`)、`packages/editor/src/ui/dialogs/UnprovenContentDialog.ts` (段階 2)
- #300 (09-09 の要件更新、10-19 の救出形式の推奨、11-01 の段階 2 の方式)、#543、#544、#317、#413、#142
- [system-spec §5.4](../system-spec.md)
