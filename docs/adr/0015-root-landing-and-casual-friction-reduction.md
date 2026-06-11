# ADR-0015: ルート `/` をモード選択ランディングにし、通常モードの起動摩擦を下げる

- **Status**: Proposed
- **Date**: 2026-06-09
- **Deciders**: (PR 上の合意者 / レビュアー)
- **PR / Commit**: (このPR)

## Context

ADR-0011 でモードを URL パスに分岐したが、導線に2つの曖昧さが残った:

- `resolveModeFromPath` は `exam/class/assignment` 以外を**全部 default→casual** にする。`/`・`/casual`・**タイポ `/exsm`** がすべて黙って casual になり、「試験のつもりが casual で記録」という**非対称な事故**を生む。`/casual` は正規ルートでなく未知パスが落ちているだけ。
- `/`(ルート) に入口/案内がなく、いきなり casual エディタが開く。さらに casual(個人・デモ・**最低保証**)に**利用規約モーダル + 画面共有ダイアログ**が出るのは、「ただ書きたい」人への過剰な摩擦。

一方、本番の主な入口は **Moodle からの直リンク (`/exam` 等)** で、ランディングを経由しない経路も維持する必要がある。

思想面の確認(ユーザーと議論):casual の摩擦低減は既存原則と**衝突しない**。ADR-0007 の「全モードで同一に capture」は**ハッシュチェーンの生信号**の話で、画面共有(スクショ)・利用規約は consent/feature レイヤ(スクショは ADR-0011 で既にモード別能力)。ADR-0011 の「保証はモードでスケール」を踏まえれば、**consent は入口で一度・assurance はモードでスケール**という方向で一貫性が増す。

## Considered Options

### ルート `/` をどうするか
- **A. `/` = casual エディタのまま(現状)**: 個人利用は0クリックだが、他モードへの案内がなく、未知パスの黙 casual も残る。
- **B. `/` = モード選択ランディング(★採用)**: 4モードをカードで選ぶ。casual は明示ルート `/casual` に。未知パスもランディングへ → 黙 casual 事故が消える。
- **C. 非ブロッキングのモード切替のみ**: バッジをメニュー化。実装は軽いが「同意/画面共有がいきなり出て意味不明」という casual の摩擦は残る。

### casual の起動摩擦
- **D. 利用規約 + 画面共有を維持**: 一貫するが、最低保証モードに過剰。
- **E. casual は同意モーダルなし・画面共有オプトイン(★採用)**: 入口(ランディング)で一度同意。画面共有は**既定オフ + バナーから後でオプトイン**(既存の opt-out バナー/`onResume` を流用)。

## Decision

**`/` をモード選択ランディング(Option B)にし、casual の起動摩擦を下げる(Option E)。**

- **ルーティング**: 新 `resolveRoute(pathname): 'landing' | EditorMode`。`/casual|class|assignment|exam`→該当 mode、**`/` と未知パス→`'landing'`**。`/casual` を**明示ルート化**し、タイポは黙 casual せず入口へ。
- **ランディング**: `LandingPage` が**重いエディタ初期化をせず DOM だけ描画**(main.ts が `route==='landing'` で `initializeApp()` を短絡)。4モードを**比較カード(料金比較ページ風)で横並び**に見せ、能力差(用途/問題配布/スクショ/封印・根束縛/証明保証)を一目で示す。カードクリックで利用規約同意フラグ (`typedcode-terms-accepted`) を set し `/<mode>` へ遷移。利用規約は**受動表示**。アクセント色は `:root[data-mode]`(landing では casual 固定)でなく**要素スコープ** (`.landing-card-mode[data-mode]`) で付ける。
- **進行中セッション表示**: `core/SessionDetector.ts` が各モードのセッション IndexedDB を**バージョン指定なしで read-only に開き**(存在しなければ `onupgradeneeded` を abort=空 DB を作らない)、最新セッションの tab 数を数えてカードに「続きから (N)」バッジを**非同期**で出す。
- **モード切替 (エディタ内)**: `ui/components/ModeSwitcher.ts` が titlebar に現モードのピル+ドロップダウンを出し(旧静的バッジを置換)、別モード選択で `/<mode>` へ遷移。storage はモード別名前空間なので**現モードの作業は失われない**。キーボード操作 (Esc/上下/フォーカス戻し) 対応。設計判断: 既存セッションのある exam/class へ切り替えるとそのモードのリロード復帰が走る(`/exam` を打つのと同じ、整合性は暗号束縛が担保)。
- **通常モード (casual) の摩擦低減**:
  - **利用規約モーダルを出さない**(`ctx.mode !== 'casual' && !hasAcceptedTerms()` のときだけ表示)。`termsAccepted` **イベントは従来どおり後段で記録**され provenance は維持。同意はランディングで一度。
  - 新能力 `promptScreenShareAtStart`(class/exam=true、casual=false)。casual は `screenshots:true`(tracker は作る)だが**起動時に勧誘せず opt-out 状態で開始**し、「画面共有を有効にする」バナーから後でオプトインできる。
  - **Turnstile `#0` humanAttestation は維持**(チェーン根整合の核)。
- 表示名 `feature.casual` を「作成」→**「練習 / Demo」**に(casual は「通常使用」でなく**お試し的な低保証枠**であることを明確化)。**内部 id・ルート `/casual`・storage 名前空間・proof `mode` ラベルは不変**(表示ラベルだけ変更=互換)。
- **入場時 UX の整理 (各モードらしい初期状態に)**:
  - **練習 (casual)**: ウェルカム画面を出さず、**既定タブ (`Untitled-1`) を 1 つ自動生成**して即編集できるようにする。
  - **授業/課題 (class/assignment)**: 起動時に問題ローダを**強制しない**。**問題パネルは問題が読み込まれるまで開かない**(未読込なのに exam の見た目「試験モード」で出る不具合を解消)。問題は左 Activity Bar の**「問題を読み込む」(`#load-problem-btn`)** で**いつでも**平文 `.tcclass` を取り込める(`capabilities.problemPanel && !sealedProblem` で表示)。リロード時は読み込み済みの問題本文を復元。
  - **問題パネル見出しはモード別** (`ProblemPanel.setTitle(t('feature.<mode>'))` → 試験/授業/課題)。固定の「試験モード」表示をやめた。
  - **課題 (assignment) に `problemPanel:true` を付与**(class と同じ非封印 tier ① の問題読込・表示を持つ)。

決め手: 本番は Moodle 直リンク主体だが、`/` に入口を置くと**導線が自己説明的**になり、**未知パスの黙 casual 事故**も同時に消える。casual の摩擦低減は consent を入口に集約し assurance をモードでスケールさせる既存思想の延長で、proof 整合(`#0`・ハッシュチェーン)には一切触れない。

## Consequences

### Positive
- 導線が明快(`/` で場面を選ぶ)。**タイポが黙って casual にならない**(`/exsm`→ランディング)。
- casual が「開いてすぐ書ける」: 同意モーダルなし・画面共有なしで起動、必要なら後でオプトイン。
- proof 整合は不変(`#0` Turnstile・ハッシュチェーン・`PROOF_FORMAT_VERSION` 据え置き)。`termsAccepted` イベントは casual でも残る。
- Moodle 直リンク (`/exam` 等) はランディングを経由せず従来どおり(未同意なら利用規約モーダルを出す既存ロジックを維持)。

### Negative / Trade-offs
- **`/` の意味が「エディタ」→「ランディング」に変わる**。casual の正規 URL は `/casual`。storage は casual=名前空間なし (`ns=''`) のままなので**互換**(既存セッションは `/casual` で見える)。
- casual proof は既定でスクショ無し=**低保証の明示**(grader は label でなく実証拠から保証度を導く、ADR-0011 §4)。
- ランディングは Monaco を mount しないが、現状 top-level 生成ぶんのチャンクは読む(完全 lazy-split は将来最適化)。

### Follow-ups / 残課題
- ランディングの完全 lazy-split(エディタチャンクを landing で読まない)。
- 利用規約を受動表示→明示チェックボックスに強化するかは運用判断。

## References

- `packages/editor/src/core/mode.ts` — `resolveRoute` / `promptScreenShareAtStart`
- `packages/editor/src/core/SessionDetector.ts` — 進行中セッション検出(空 DB を作らない read-only open)
- `packages/editor/src/ui/components/LandingPage.ts` — 比較カードのランディング
- `packages/editor/src/ui/components/ModeSwitcher.ts` — titlebar のモード切替ピル
- `packages/editor/src/main.ts` — landing 短絡 / casual の terms 省略・画面共有 opt-out 分岐 / ModeSwitcher 初期化
- `packages/editor/src/app/TermsHandler.ts` — `markTermsAccepted` / `hasAcceptedTerms`
- [ADR-0011](0011-course-modes-and-path-routing.md) — モード体系・パス分岐(本 ADR が `/` 入口を補う)
- [ADR-0007](0007-maximal-signal-capture.md) — 生信号 capture(本 ADR は触れない)
- [ADR-0014](0014-class-mode-unsealed-problem-distribution.md) — 授業モード
