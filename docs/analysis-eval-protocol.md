# 分析器 実証評価プロトコル (参照手順 + ハーネス)

分析層 (ADR-0009) のアナライザが、ラベル付きコーパスでどれだけ「当てる/誤る」かを**自分の現場のデータで測る**ための参照プロトコルと評価ハーネス。

> **位置づけ (ADR-0023)**: **TypedCode は判定器ではない**。我々はデータを収集して既定分析器に「正解の閾値」を焼き込むことはしない。本書は、**採点者・研究者が自分のデータと自分の分析器**で「ある手掛かりを `review` 扱いにしたとき本物をどれだけ巻き込むか (偽陽性) / 自動制作をどれだけ取りこぼすか (偽陰性)」を測るための手順とツール。最終判断は常に採点者・研究者にある。自前の分析器は verify-cli の `--analyzer <module>` で差し込める (フォーク不要)。

---

## 0. 何のための評価か

ある手掛かりを採点者の注意に値する `review` に上げてよいか (= 偽陽性率が許容内か) は、打鍵分布・IME 挙動・転写癖に依存し**現場ごとに違う**。だから:

- **TypedCode 同梱の既定分析器は advisory プレースホルダのまま** (`notice` 止まり)。我々は実測で閾値を焼いて `review` に昇格しない (ADR-0023)。`automation` の環境シグナル (`navigator.webdriver` / 自動化グローバル / `isTrusted=false`) のみ既に `review` だが、これはヒューリスティックではなく決定的な事実 tell。
- **昇格の判断は分析器を運用する側 (採点者/研究者) が、自分のコーパスで行う**。本ハーネスはそのための測定器。自前分析器を `--analyzer` で載せ、本書の手順で FP/FN を測り、§4 の基準で閾値を決める。

---

## 1. コーパスの条件設計

各参加者・各条件で 1 セッションずつ proof を収集し、`genuine` / `automated` のラベルを付ける。

### genuine (本物の逐次タイピング)

| condition | 説明 |
|---|---|
| `genuine-noime` | 通常の英字コーディング (試行錯誤・修正・実行あり) |
| `genuine-ime` | 日本語コメント等で **IME 変換**を伴う入力 (打鍵動態が IME で歪む正規ケース) |
| `genuine-think-burst` | 数分離席して設計を考え、戻って一気に書く正規ケース (focus-burst の偽陽性圧を測る要) |

### automated (自動制作・転写)

| condition | 説明 | 主に踏むべき次元 |
|---|---|---|
| `ai-paste` | AI 出力をコピー&ペースト | transcription-topology (pureTyping) |
| `transcribe-noime` | AI 出力を見ながら**一字一句**打ち直す (手戻りなし) | transcription-topology |
| `transcribe-ime` | 同上だが日本語含みで IME 経由 | transcription-topology |
| `synthetic-keystroke` | 拡張/スクリプトが合成打鍵を dispatch (`isTrusted=false`) | automation |
| `webdriver-headless` | Playwright/Selenium 等の自動化ブラウザ | automation |

**IME を縦軸に持つ理由**: IME 変換は打鍵 1 つあたりの確定文字数・タイミングを大きく変える。IME ありの genuine が偽陽性を増やすなら、その次元は IME ユーザを不当に巻き込むため `review` 昇格できない。逆に automated 側も IME 経由 (`transcribe-ime`) で検出力が落ちないかを見る。

### 規模の目安

第一次の意思決定には **各 condition 10〜20 セッション**を目標 (genuine 合計 ≳ 40、automated 合計 ≳ 40)。少数でも「genuine が `review` を 1 件でも出す」事実は昇格を止めるに足る (§4)。

---

## 2. 同意と倫理 (データ最小化)

- **参加同意**: 収集前に、打鍵タイミング・編集列が proof に記録され分析評価に使われること、撤回可能であることを説明し同意を得る。授業/試験の実運用ログを評価に流用しない (別目的利用しない)。
- **データ最小化** (ADR-0024 の目的別ティア): 評価に必要なのは proof (イベント列・タイミング) のみ。**コード内容そのものは評価に不要**なら匿名化/破棄してよい (`content` を伏せても分析の大半は動く)。整合性検証 (Tier F) は全イベントを要するが、分析・共有は content-free 派生物 (Tier A) で回す。個人特定情報を別添しない。ラベルは condition と genuine/automated だけ。
- **保管**: コーパスはリポジトリにコミットしない (`/tmp` または評価者ローカル)。`labels.json` も同様。
- これは ADR-0009 の「感度の高い本物の分析器は採点者側に private で持つ」方針と整合する — 評価データも公開しない。

---

## 3. 収集と実行

### 3.1 proof の用意

- **実データ**: editor で各条件のセッションを実際に行い、proof をエクスポート。1 ファイル = 1 セッション。
- **合成スモーク (実データの代替ではない)**: パイプライン疎通とハーネス回帰確認用に合成コーパスを生成できる。
  ```bash
  GEN_FIXTURES=1 npx vitest run analysisEvalCorpus -w @typedcode/shared
  # → /tmp/typedcode-fixtures/corpus/*.json + labels.json, eval-report.{json,md}, eval-signals.json
  ```
  合成データは人間の打鍵分布を模していないため、**しきい値の意思決定には使わない**。

### 3.2 ラベル manifest

コーパスディレクトリに `labels.json` を置く (キー = ファイル名)。

```json
{
  "p001.json": { "label": "genuine",   "condition": "genuine-ime" },
  "p002.json": { "label": "automated", "condition": "ai-paste" }
}
```

### 3.3 評価実行

```bash
EVAL_CORPUS=/path/to/corpus npx vitest run analysisEvalCorpus -w @typedcode/shared
# → <stdout> に Markdown レポート + /tmp/typedcode-fixtures/eval-report.{json,md}
```

集計ロジックは shared の純粋関数 `evaluateAnalysis` (`packages/shared/src/analysis/eval.ts`)。proof → `runAnalysis` → `LabeledAnalysis[]` → `evaluateAnalysis`。CI 対象の単体テストは `analysisEval.test.ts`。

### 3.4 自前の分析器を測る (ADR-0023)

既定分析器ではなく**自分の手法**を評価したい場合、verify-cli で外部分析器を proof / コーパスに走らせて `--analysis-json` で出力を取り、自前の集計に渡す:

```bash
typedcode-verify proof.json --analyzer ./my-analyzer.mjs --analysis-json out.json
# 既定を外して自前だけ: --no-default-analyzers --analyzer ./my-analyzer.mjs
```

外部モジュールは ADR-0009 の `Analyzer` 契約 (`{ id, version, analyze(input) }`) を default / `analyzer` / `analyzers` で export する。`analyze` には検証済み proof の全イベント列・fingerprint・`FullVerificationResult` が渡る (§References)。**注意**: `--analyzer` は任意モジュールを動的 import するため、信頼できるモジュールだけを渡すこと。

---

## 4. 指標と昇格基準

`evaluateAnalysis` が出す指標:

- **genuineSignalRate (headline)**: genuine コーパスが各 severity 以上の signal を出してしまった割合。
- **軸別スイープ**: overall (reviewPriority) と各 dimension について、予測スコアの閾値を振った混同行列 (tp/fp/tn/fn・precision/recall/F1・**FPR**)。
- **推奨閾値**: FPR 上限 (既定 5%) を満たす中で recall 最大の点。

### 昇格を**許可しない**条件 (どれか 1 つでも該当)

1. その dimension の **genuine 偽陽性率 (FPR) が、recall が実用的な閾値帯で 5% を超える**。
2. その dimension が genuine を巻き込む一方で automated をほぼ捕えない (= **F1 が低く FPR だけ高い**)。合成例では `focus-burst-correlation` がこれに該当した (P0%/R0%/FPR25%) → **昇格不可**の典型。
3. **IME あり** condition の genuine だけ偽陽性が突出する (IME ユーザを不当に巻き込む)。

### 昇格を**検討してよい**条件 (すべて満たす)

- 推奨閾値で **FPR ≤ 5%** かつ **recall が意味のある水準**。
- IME 有無で genuine 偽陽性に大きな差がない。
- 偽陽性だった genuine セッションを人手で検分し、真に紛らわしい (= 本来レビューしてよい) ものだと確認できる。

昇格する場合も、severity を上げるのは **当該 dimension・当該閾値のみ**。閾値は `eval-report.json` の `recommended.threshold` を出発点にアナライザ側へ反映し、その PR に本レポートを添える。

---

## 5. 誠実な限界

- **合成コーパスは実証の代替ではない**。打鍵分布・思考停止・IME 挙動は実データでしか測れない。
- **CDP / ハードウェア注入は `isTrusted=true`** で、automation アナライザでも検出できない (ADR-0018)。本評価が測れるのは「検出可能な自動化」に対する性能だけ。最終防衛は proctor + process-first (ADR-0020 三層保証の著述性は常に advisory)。
- アナライザは**判定しない**。本プロトコルの結論は「どの手掛かりを採点者の注意に値する `review` に上げてよいか」であって、合否の自動化ではない。

---

## 6. 関連

- ADR-0023 (分析を判定器ではなく差込み基盤として位置づける — 本書の前提)
- ADR-0009 (分析層の直交性・advisory 原則・private 分析器)
- ADR-0018 (`isTrusted` 合成打鍵捕捉とその限界)
- ADR-0020 (三層保証語彙: 著述性は常に advisory)
- `Analyzer` / `AnalysisInput` / `AnalysisSignal` 契約 (`packages/shared/src/analysis/types.ts`)
- `packages/shared/src/analysis/eval.ts` (`evaluateAnalysis`)
- `packages/shared/src/__tests__/analysisEvalCorpus.test.ts` (合成生成 + 実データ評価ランナー)
- `packages/verify-cli/src/analyzers.ts` (`--analyzer` 外部分析器読込)
