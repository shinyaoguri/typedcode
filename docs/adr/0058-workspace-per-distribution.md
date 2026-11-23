# ADR-0058: 問題の配布物ごとに作業スペース (URL と保存領域) を分ける

- **Status**: Accepted
- **Date**: 2026-11-23
- **Deciders**: @shinyaoguri
- **PR / Commit**: (#646 を閉じる PR。方針の決定は #646 の 2026-11-23 のコメント)

## Context

[ADR-0011](0011-course-modes-and-path-routing.md) は保存領域 (IndexedDB のセッション DB と localStorage / sessionStorage のキー) を **モード単位** で分けた (`typedcode-session` / `-class` / `-assignment` / `-exam`)。[ADR-0046](0046-entry-without-mode-choice.md) で学生がモードを選ばなくなり (段階 1 = #644)、`.tcclass` の方針が授業と課題の能力を決めるようになった (段階 2 = #645)。残った問題は次のとおり。

- 練習 (`/`) で書いている途中に問題を読み込む導線が無い。`/class` `/assignment` で問題を読み込むと、その入口の保存領域に問題のタブが積み上がり、別の授業の問題や前回の課題のタブと混ざる。
- `proof.mode` が入口のパスのままで、`/class` で持ち帰りの問題を読むと「mode は class でスクリーンショット無し」になる (#645 の残り)。
- 同じ授業の配布物を差し替えた (改訂した) ときに、書いていたタブを残して問題文だけを替える手段が無い。

## Considered Options

### Option A: モード単位の保存領域のまま、問題ごとにタブを分けるだけ
- Pros: 保存領域の仕組みを変えない。
- Cons: 別の授業・前回の課題のタブと同じ領域に混ざる。リセットや復旧ダイアログが全部の問題をまとめて扱う。`proof.mode` は入口のまま。

### Option B: 配布物 (classId) ごとに保存領域を分け、改訂ごとにも分ける
- Pros: 配布物の版ごとに記録がきれいに分かれる。
- Cons: 誤字の直しのような改訂でも、学生は書いていたタブを失ったように見える (別の領域に移る)。

### Option C: 種別・配布物 ID・方針で作業スペースを決め、同じ作業スペースの改訂は問題文だけを差し替える
- Pros: 改訂で書いていたタブが残る。方針 (教室で実施 / 持ち帰り) が途中で変わらない (方針が違えば別の作業スペース)。`.tcclass` と、将来の `.tcexam` の作業スペース (#889) が種別で分かれる。
- Cons: 作業スペースの数だけセッション DB が増える。

### 旧来の保存領域の扱い
- (a) 新しい作業スペースへコピーしてから切り替える: 記録のチェーンと署名はセッション ID に結びついている (署名済み checkpoint の `sessionId`・root の token。ADR-0027 / ADR-0057) ので、別の DB へのコピーは記録を壊す危険がある。
- (b) 移しも消しもしない: 旧来の URL で今どおり開ける。保存領域は残り続ける。

## Decision

**Option C と (b) を採る。**

- **作業スペースの名前**: 種別を先頭に置き、各部分を `encodeURIComponent` で符号化して `:` でつなぐ。`.tcclass` は `class:<classId>:<方針の符号>`、試験は `exam:<examId>[:<variant>]` を予約する (#889。今はルートも保存領域も持たない)。方針の符号は `classroom` (教室で実施 = `/class` の能力) / `take-home` (持ち帰り = `/assignment` の能力) / `custom-<s><f><b>` (スクリーンショット・フルスクリーンの記録・export 前認証の best-effort を 0/1)。`:` は `encodeURIComponent` が必ず符号化するので、classId に何が入っても別の作業スペースの名前にならず、/author が examId を classId に流用しても試験と混ざらない。
- **URL**: `/w/class/<encodeURIComponent(classId)>/<方針の符号>`。起動の最初に URL から同期的にモードと名前空間を決める。形の崩れた `/w/...` は not-found (ADR-0046 の「未知パスを黙ってエディタにしない」)。classId が `.` / `..` の配布物は、ブラウザがパスの `.` / `..` として畳むので開かない (読み込みを断る)。
- **保存領域**: 名前空間を `-w:<作業スペースの名前>` にする (セッション DB は `typedcode-session-w:class:<classId>:<方針>`)。旧来の名前空間は `-w:` で始まらないので重ならない。二重起動の検出 (`SingleInstanceGuard`) の名前も `w:<作業スペースの名前>` (旧来の入口はモード名のまま)。リセットはその作業スペースの領域だけを消す。
- **移り方**: `.tcclass` を読み込むと、方針 (無ければ入口の既定) から作業スペースを決める。今の作業スペースと同じなら **改訂** として、同じファイル名のタブは作り直さずに問題文だけを差し替え、タブの無い問題だけタブを作る。違えば、移り先の名前空間に方針 (localStorage) と配布物 (sessionStorage) を書いてからページごと移り、移り先の起動が配布物を受け取って (消してから) 問題のタブを開く。今のページは表示言語の切替と同じく、確認を出さずに保存して離れる (`skipUnloadConfirm`)。
- **入口の既定の方針** (方針の無い旧 `.tcclass`): 練習 (`/`) と `/assignment` は持ち帰り、`/class` は教室で実施、作業スペースの中はその作業スペースの方針。
- **`proof.mode`**: 作業スペースでは方針から決める。教室で実施 = `class`、持ち帰り = `assignment`、プリセットに無い組み合わせはスクリーンショットを撮るなら `class`、撮らないなら `assignment`。`proof.mode` は自己申告のラベルで、検証は信頼に使わない (ADR-0020) ので、proof の形式 (`PROOF_FORMAT_VERSION`) は変えない。
- **旧来の保存領域** (`typedcode-session` / `-class` / `-assignment` / `-exam` とそのキー) は移さず、コピーせず、消さない。`/` `/casual` `/class` `/assignment` `/exam` は今どおりその領域を開く。`/class` `/assignment` は、問題を読み込むと作業スペースへ移る入口として残る。

ADR-0011 の「ストレージはモード別に名前空間化」は、問題を読み込んだ後の保存領域については本 ADR が置き換える (旧来の入口の領域はそのまま残る)。

## Consequences

### Positive
- 練習・授業・課題・別の配布物のタブが混ざらない。練習の途中で問題を読み込んでも、`/` に戻れば練習のタブが残っている。
- 改訂で書いていたタブと記録が残る。
- 方針が途中で変わらないので、動いているページの能力を切り替える経路 (#645 の `applyClassPolicy`) が要らなくなった。能力は起動時に決まる。
- `proof.mode` が配布物の方針と一致する。
- 証明の形式、Turnstile の `#0`、`DB_VERSION`、試験の封印・監督コード・根束縛には触れない。

### Negative / Trade-offs
- 作業スペースの数だけセッション DB が残る。消すのは各作業スペースのリセットだけ (ADR-0057 の「利用者の明示の操作なしに消さない」と同じ姿勢)。
- 作業スペースの URL を手で書き換えると、別の (空の) 作業スペースが開く。方針は URL の一部なので、URL を書き換えて方針を変えたことにはならない (その領域に読み込まれた問題は無い)。
- 移る直前に PoSW の処理待ちが残っているイベントは、表示言語の切替と同じく sessionStorage への同期保存と、移る前の IndexedDB への保存 (`flushToIndexedDB`) で残す。処理待ちそのものは待たない。

### Follow-ups / 残課題
- 試験の作業スペース (`exam:<examId>[:<variant>]`) は #889。封印解除と根の束縛に絡むので分けた。
- 旧来の保存領域を整理する手段 (一覧・削除) は持たない。要るなら別の Issue で。

## References

- [ADR-0011](0011-course-modes-and-path-routing.md) — モード別の名前空間 (問題を読み込んだ後の保存領域は本 ADR が置き換える)
- [ADR-0046](0046-entry-without-mode-choice.md) — 段階 3 (#646)
- [ADR-0057](0057-keep-closed-tabs-as-archive.md) — 記録を利用者の明示の操作なしに消さない・署名はセッション ID に結びつく
- [ADR-0020](0020-three-layer-assurance-vocabulary.md) — `mode` は自己申告のラベル
- `packages/editor/src/core/mode.ts` — `workspaceName` / `classWorkspacePath` / `parseWorkspacePath` / `modeForClassPolicy` / `classWorkspaceFor`
- `packages/editor/src/core/storageKeys.ts` — `workspaceStorageNamespace` / `setWorkspaceStorageNamespace` / `instanceGuardNamespace`
- `packages/editor/src/services/PendingClassPackageStore.ts` — 移り先への配布物の受け渡し
- `packages/editor/src/main.ts` — `runClassLoad` / `moveToClassWorkspace` / `openPendingClassPackage` / `openClassTabs`
- Issue #643 (親) / #645 / #646 / #889
