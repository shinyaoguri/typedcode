# ADR-0011: 授業・課題・試験を1ドメインのパスで分岐し、能力プリセットでモデル化する

- **Status**: Accepted (実装済み・develop マージ済み)
- **Date**: 2026-06-07 (Accepted: 2026-06-08)
- **Deciders**: (PR 上の合意者 / レビュアー)
- **PR / Commit**: #81 (ADR) / #82 #83 #84 (PR1–3 実装。develop マージ済み)

> ADR-0006（封印問題束縛）/ 0008（fullscreen）/ 0009（分析層）/ 0010（試験セッション構造）で **試験モード**を確定した。本 ADR は視野を広げ、**大学演習授業の全工程**（授業中の利用・授業中ワーク・持ち帰り課題・試験）で TypedCode をどう使うか、その **モード体系・ルーティング・モード真正性・データ姿勢** を決める。**ADR-0010 の sticky モード機構（`?exam=1` + localStorage + `?reset`）は本 ADR の path 方式が置き換える。**

## Context

TypedCode が握るレバーは2つ: **① ペースト遮断＝タイピング強制（ADR-0005）** と **② 改ざん耐性あるプロセス記録＋転写/オーサリング判別（ADR-0009）**。試験モードの暗号機構（封印・監督コード・根束縛）は **物理 Air-gap がある前提**でのみ意味を持つ。

授業で使う場面は Air-gap の強さで段階がある:

- **試験**: 監督下＋問題を秘匿（封印）。最高保証。
- **授業中ワーク / 授業中利用**: 教員在室という**物理 Air-gap はあるが封印は不要**（問題は公開、緩い）。
- **持ち帰り課題**: Air-gap **無し**。Google・レジュメ・相談は**許可**。防ぎたいのは「AI 生成の右から左へのコピペ」だけ。

重要な前提（議論で確定）:

- **課題は "摘発" でなく "摩擦 + formative"**: 別端末で AI 生成しても、ペースト遮断で**少なくとも写経を強制**できる。価値は学習証明ではなく **コスト・可視化・プロセス記録・ベースライン蓄積**。資源を開放するほど「転写検出」は AI を名指しできない（Stack Overflow の転写と区別不能）ので、課題 proof を実力証明扱いしない。
- **TypedCode はデータを保存・収集・送信しない**: IndexedDB はクラッシュ/リロード復旧のみ。提出ログの蓄積は **Moodle 側**。ベースライン化・個人比異常検知は **grader 側**（ADR-0009）。
- 既存の `?exam=1` + sticky localStorage + `?reset` は、**クエリパラメータが一時的**ゆえの回避策で、抜けにくさと事故の温床。

## Considered Options

モード（どの場面か）をクライアントに伝える経路の比較。判断基準: (a) `typedcode.dev` 一本化、(b) dev/preview/本番で同一挙動、(c) リロードでモード保持、(d) モード間ストレージ分離、(e) 配線の軽さ、(f) Moodle リンクの明快さ。

### Option A: サブドメイン（`exam.typedcode.dev` 等）
- Pros: origin が分かれ **ストレージ分離がブラウザ保証**。モード identity が最も明快。
- Cons: **preview/staging（`<branch>.typedcode.pages.dev`）でサブドメインを切れず dev 同一挙動が崩れる**。DNS / CORS / 配線が重い。1ドメイン集約に反する。

### Option B: パス（`typedcode.dev/exam` `/class` `/assignment`、`/verify`）★採用
- Pros: **1ドメイン・1ビルド・1 Pages・1 CORS origin**。dev/preview/本番が同一挙動（`localhost:5173/exam` 〜 `typedcode.dev/exam`）。**path はリロードで残る**ので毎回 URL からモード確定でき、**sticky フラグも `?reset` も不要**。リンクが明快。
- Cons: 同一 origin ゆえ **ストレージ分離は "規約"**（IndexedDB の DB 名 / localStorage prefix をモード別にする）であり、ブラウザ保証ではない。Pages に SPA フォールバック（`_redirects`）が要る。

### Option C: クエリパラメータ（現状 `?exam=1`）
- Pros: 最小実装、1ドメイン。
- Cons: **パラメータが一時的で消えやすい** → sticky localStorage + `?reset` の回避策が必須（=現状の痛点）。リンクが冗長。modifier 意味論で "場所" にならない。

## Decision

### 1. ルーティング = パス方式（Option B）
`typedcode.dev/{exam,class,assignment}` と `typedcode.dev/verify`（検証はモード非依存）。1ビルドで `location.pathname` からモードを確定。**path はリロードで永続**するので、ADR-0010 の sticky localStorage + `?reset` を撤廃する。ストレージはモード別に名前空間化（IndexedDB DB 名 `typedcode-{mode}`、localStorage キー prefix）。dev/preview は同じパスで動く。

> **path > query の決め手**: 現状 sticky が要るのは「クエリが消えるから」。path は "場所" なので消えず、sticky 機構ごと不要にできる。"一本化" と "sticky 撤廃" を同時に満たすのは path だけ。

### 2. 整合性は "閉じ込め" でなく "束縛" から来る
sticky の裏の動機（URL 改竄で試験モードから逃げられない）は不要。**逃げても無効**: `/exam` を離れたら封印・根束縛の無い別 proof になるだけで、提出すべき有効な試験 proof は作れない。**試験の整合性は封印パッケージの暗号束縛（ADR-0006）が担保**するので、モードに閉じ込める必要がない。

### 3. 3モード = 1コア + 能力プリセット
3つの "モノリス" でなく、**共通コア + トグル集合のプリセット**として持つ。各モードは「決定的特徴」で定義する:

- **試験** = 封印問題＋監督コード＋**根束縛**を持つ唯一のモード。
- **授業** = 監督下だが**封印しない**（"封印無しの監督下"）。**授業中ワークはここ**。評価する/しないは Moodle 側の使い方の差でモードを増やさない。
- **課題** = 持ち帰り・Air-gap 無し・formative。**スクショ無し**（自宅＝プライバシー）。

| 能力 | 授業 | 課題 | 試験 |
|---|---|---|---|
| ペースト遮断＋ハッシュ記録＋分析（**コア**） | ⭕ | ⭕ | ⭕ |
| サーバ best-effort（Turnstile＋時刻アンカー） | ⭕ | ⭕ | ⭕ |
| 封印問題＋監督コード＋根束縛 | ❌ | ❌ | ⭕ |
| スクリーンショット | △（教室なので可） | **❌（プライバシー）** | ⭕ |
| フルスクリーン | 任意 | なし | 要求（非強制, ADR-0008） |
| タブ固定 / 復帰（ADR-0010） | 緩 | 最小 | 強 |
| Air-gap の源 | 教員の在室 | なし | 監督＋封印 |
| proof の保証ラベル | 中 | **低（formative）** | 高 |

### 4. モード/問題の真正性 = 3段階。課題/授業は ①自己申告
proof が「どのモード・どの問題か」をどこまで偽れない形にするか:

- **① 自己申告（メタデータ）** — proof に `mode` / `problemId` を書くだけ。**課題/授業の既定**。
- **② 署名付き記述子（signed descriptor、非暗号）** — 先生が署名した記述子に proof を束縛。authenticity と問題/版の束縛を与えるが暗号化はしない。**per-student variant をやる時のみ**。
- **③ 封印（`.tcexam`）** — ②＋暗号化＋監督コード＋根束縛。**試験のみ**。

**課題/授業は ① で十分かつ安全**。理由:

- **"上" に偽れない**: 低保証の課題を「試験 proof だ」と詐称しても、試験の保証は `mode` ラベルでなく**封印の暗号束縛**から来るので `verifyExamBinding` で落ちる。偽る価値のある唯一の嘘は暗号が既に塞いでいる。
- **"下" に偽る動機がない**。
- **取り違えは Moodle が拾う**（提出枠が問題を確定）。
- **採点側は label を鵜呑みにせず、実証拠（束縛の有無・スクショの有無）から保証度を導く**。

**持ち帰り課題で per-student variant をやる予定は無い**ため、当面 ② は実装しない。② は ① の proof を壊さず**加算的に後付け可能**。

### 5. データ/プライバシー
TypedCode は**保存も収集もしない**。IndexedDB はクラッシュ/リロード復旧のみ。**送信は Turnstile と時刻アンカー（署名 cp）の不透明なハッシュ＋時刻＋クライアント生成 sessionId のみ**（コード/キーストローク/PII は出さない）で、**全モードで維持**（KV は timing メタデータを 7 日 TTL で保持＝リプレイ防止）。ログの蓄積は Moodle 側、ベースライン/分析は grader 側。

### 6. proof にモード/能力集合を記録
proof に **動作したモードと能力集合**を記録し、ハッシュチェーンに焼く。課題 proof が試験 proof のフリをできないよう、保証ラベルは**実証拠から機械判定**できるようにする（自己申告 label を信頼判定の根拠にしない）。

## Consequences

### Positive
- **一本化**: 全モードが `typedcode.dev/{mode}` の1ドメイン・1ビルド。dev/preview/本番が同一挙動。
- **sticky 撤廃**: path 由来でモード確定 → ADR-0010 の localStorage sticky と `?reset` を削除でき、抜けにくさ/事故が消える。
- **授業全体で一貫**: 1ツールで授業〜試験まで。学生は同じ UX に慣れる。
- **ベースライン強化**: 低リスクな授業/課題で各学生の "素の打ち方" が Moodle 側に貯まり、**試験時の分析が汎用→個人化**して強くなる（formative が summative を強化）。
- **プライバシー最強**: "データはブラウザ外に出さない（不透明な時刻アンカー除く）" を全モードで貫ける。

### Negative / Trade-offs
- **ストレージ分離が規約依存**（ブラウザ保証でない）。信頼された単一アプリなので実害は無いが、名前空間化を実装で徹底する必要がある（試験の機密性はデータ秘匿でなく暗号束縛で守るので、ハード分離は不要）。
- **課題の保証は低い**（formative と割り切る）。AI 写経は防げない。実力評価は試験＋評価設計（反復/デバッグ/口頭試問）に委ねる。
- **ADR-0010 の sticky モデルを置換する移行コスト**。

### Follow-ups / 残課題
- 実装: path ルーティング + Pages SPA フォールバック / storage 名前空間化 / `?exam=1`・sticky・`?reset` の撤去 / モードを能力プリセット化 / proof に mode・能力集合を記録 / 課題モードでスクショ無効。
- 出題者/課題作成ツール（[#80](https://github.com/shinyaoguri/typedcode/issues/80)）を「署名する／さらに封印する」の1系統で 3 モード分の配布物を出せるようにする。
- ② 署名記述子は per-student variant を採る段で起こす（別 ADR）。
- proof の "保証ラベル/能力集合" スキーマと、grader 側での保証度導出を定義する。

## References

- [ADR-0006](0006-exam-mode-sealed-problem-binding.md) — 封印問題束縛（試験の暗号機構・③封印の実体）
- [ADR-0008](0008-exam-fullscreen-request-not-enforce.md) — fullscreen 要求（試験のみ）
- [ADR-0009](0009-pluggable-analysis-layer.md) — 分析層（grader 側・全モードの転写判別）
- [ADR-0010](0010-exam-session-model.md) — 試験セッション構造（**本 ADR が sticky モデルを置換**）
- [ADR-0005](0005-input-type-policy.md) — ペースト/import の構造的禁止（全モード共通コア）
- Issue [#80](https://github.com/shinyaoguri/typedcode/issues/80) — 教員向け問題/課題作成ツール
- `packages/editor/src/main.ts` — 現状の `?exam=1` + sticky 入口（path 方式へ置換対象）
