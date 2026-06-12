# packages/verify-cli — CLAUDE.md

`@typedcode/verify-cli` は **Node.js から proof ZIP / JSON を検証する CLI**。CI / バッチ / 自動化用途。

## 責務と境界

- **持つ**: JSON / ZIP の解析、チェーン検証 (`@typedcode/shared` の `verifyProofFile` を使う)、PoSW 検証、署名済み cp 検証、結果の整形と終了コード
- **持たない**: 独自の暗号ロジック (すべて `shared` に委譲)、UI (verify 側)、proof 生成 (editor 側)

## 動作要件

- **Node.js ≥24** (`engines` で強制)
- ルート `package.json` engines `>=24` と同じ。`.node-version` は `24.4.1`、GitHub Actions も `node-version: '24'`

## 重要な不変条件

1. **`shared` の検証ロジックを再実装しない**: バグや暗号アルゴリズムの修正は shared 側で行う。CLI 側で差分があると 「Web で OK / CLI で NG」 のような不整合事故が起きる
2. **終了コード**: 0 = 成功、1 = 失敗 / エラー。これが CI で利用されるので変えない
3. **ZIP 内の proof は全件検証する**: exam/class はタブ毎に独立した `<name>_proof.json` を N 個出力するので、`shared` の `extractAllProofsFromZip` で全件を取り出し、**1 件でも fail なら exit 1**。最初の 1 件だけ見ると未検証タブが exit 0 で通る (proof 判定は構造 `isProofFile` で、ファイル名順や `screenshots/manifest.json` に依存しない)
4. **stdout は人間向け、stderr はエラーログ**: パイプして grep される可能性を考慮

## ファイル構成

```
src/
├── cli.ts         # エントリポイント
├── verify.ts      # 検証ロジック (shared を呼ぶ薄いラッパ)
├── output.ts      # 結果の整形
├── progress.ts    # 進捗表示
└── zip.ts         # ZIP 処理
```

## よくある罠

- **`@typedcode/shared` の `main` は `src/index.ts` (raw TypeScript)**: tsc コンパイル後の `dist/cli.js` を `node` で直接実行すると `ERR_MODULE_NOT_FOUND` が出る。これは pre-existing でモノレポ内ローカル実行時の構成課題。**Node のバージョンとは無関係**。公開時にはバンドルが必要 (将来課題)
- **新しい proof フォーマットへの対応**: shared 側で `parseJsonString` / `parseZipBuffer` を拡張すれば CLI もそのまま追従する。CLI 側に判定ロジックを書かない
- **進捗表示は TTY 検出**: パイプ先や CI ログでは ANSI エスケープを抑制する

## 試験モード (ADR-0006) の検証

- `--exam-package <file.tcexam>` (任意): 指定すると shared の `verifyExamBinding` で署名→packageHash→root→内容ハッシュ→time-box まで完全検証する。**未指定でも** `proof.exam` のある proof は root 束縛 (自己完結) を検証し「package 未提供」を明示する
- `--submitted-at <ISO>` (任意): time-box の `withinWindow` 判定 (Moodle 提出時刻)。未指定なら window 表示のみ
- package 指定で束縛失敗は **exit 1**。exam 束縛のみ失敗時は出力ヘッダに束縛理由を出す (chain の成功メッセージを誤表示しない)
- ロジックは全て shared (`verifyExamBinding` / `parseExamPackageManifest`) に委譲。CLI は薄いラッパに留める

## アンカー密度 gate (ADR-0016)

- `--require-anchor-density` (任意・boolean): 署名 cp が「主張したイベント数 / 経過時間」に対して**疎**な proof を **exit 1** にする (採点向け opt-in)。既定は warning のみで `Anchoring` 行の下に `! Anchoring is sparse …` を出す
- 判定は shared の `verifySignedCheckpoints` (`requireAnchorDensity`) に委譲。CLI は `verifyProofFile` にフラグを通すだけ。閾値 (cadence×5) も shared 側が単一ソース
- 末尾 1 個の署名 cp で長いチェーンをアンカーする手口を捕捉する (`coverageRatio` は 1.0 でも疎)。**非破壊** (proof フォーマット不変)

## root アンカー gate (ADR-0017)

- `--require-root-anchor` (任意・boolean): root がサーバアンカーされていない (`sessionStartToken` 無し = オフライン劣化 / 旧 proof) proof を **exit 1** にする (採点向け opt-in)。既定は warning のみで `Root anchor: unanchored` を出す。**exam proof は対象外** (独自の T0 束縛を持つ)
- 判定は shared の `verifyProofFile` (`requireRootAnchor`) に委譲。CLI はフラグを通すだけ。proof は `PROOF_FORMAT_VERSION` 1.2.0 (`MIN_SUPPORTED` 1.0.0 据置) なので **旧 proof もそのまま検証**でき、`rootAnchored:false` で受理 (後方互換)

## 分析層の出力 (ADR-0009)

- 検証 (`--- Checks ---`) と**直交する advisory** を `--- Analysis (advisory) ---` セクションに出す。判定ではない (**exit code には一切影響させない** — ここを破ると ADR-0009 の直交性が壊れる)
- 各 signal は severity (`INFO`/`NOTICE`/`REVIEW`) + summary + **evidence (event index)** を出す。evidence は人間が当該イベントを検分するためのリンクで ADR-0009 上必須
- `--analysis-json <out.json>` (任意): 全 proof 分の `{filename, valid, analysis}` を JSON でファイル出力する。分析器の評価ハーネス / コホート集計の機械可読な入口 (Phase 8 W5)。advisory のみで exit code 非干渉
- 分析ロジックは shared の `runAnalysis` に委譲。CLI 側に分析器を書かない
