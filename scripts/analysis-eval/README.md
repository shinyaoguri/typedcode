# scripts/analysis-eval

分析器 (ADR-0009) を **実測**で評価するための運用入口。集計ロジック自体は重複を避けて
shared に置いてある (`packages/shared/src/analysis/eval.ts` の純粋関数 `evaluateAnalysis`、
CI 対象)。ここはその回し方をまとめた薄いポインタ。

収集条件・同意・昇格基準は [docs/analysis-eval-protocol.md](../../docs/analysis-eval-protocol.md)。

## 合成スモーク (パイプライン疎通・実データの代替ではない)

```bash
GEN_FIXTURES=1 npx vitest run analysisEvalCorpus -w @typedcode/shared
```

ラベル付き合成コーパスを生成して評価し、以下を書き出す:

- `/tmp/typedcode-fixtures/corpus/*.json` + `labels.json` — 生成 proof とラベル
- `/tmp/typedcode-fixtures/eval-report.{json,md}` — 評価レポート
- `/tmp/typedcode-fixtures/eval-signals.json` — 各 proof の生 signal (診断用)

## 実データ評価

`<dir>/labels.json` (キー=ファイル名 → `{label, condition}`) と proof JSON を並べ:

```bash
EVAL_CORPUS=/path/to/corpus npx vitest run analysisEvalCorpus -w @typedcode/shared
```

`evaluateAnalysis` が overall + 各 dimension の混同行列・閾値スイープ・FPR 上限下の推奨閾値、
および headline の genuineSignalRate (本物が誤って signal を出す率) を算出する。

## ゲート

実測で FPR が許容内 (§4 の基準) と示されるまで heuristic アナライザを `severity: 'review'` に
昇格させない。昇格 PR には必ず本評価レポートを添える。
