# ADR-0054: 検証とログ再生を公開 SDK にし、公式 Web・CLI も同じ API を使う

- **Status**: Accepted (方針決定済み、実装は #811〜#813)
- **Date**: 2026-11-18
- **Deciders**: @shinyaoguri
- **PR / Commit**: #805 を閉じる文書 PR

**要約**: 外部アプリがログからサービスを作れるように、高水準の提出物検証と仕様別の文書再生を提供する。検証済みの範囲と派生データの限界を型・結果・文書で明示する。
**人が判断すること**: なし。npm の権限と公開環境は配布段階で確認し、本 ADR で公開やサービス運用は行わない。

## Context

外部アプリが TypedCode のログを使って学習分析、履歴再生、提出物管理などを作れることが求められた (#804)。暗号仕様や旧形式の分岐を各アプリが再実装すると、公式の検証結果と食い違う。

現行 shared はブラウザ・Node 共通の `verifyProofFile` 等を公開するが、root entry は記録、指紋、分析も含む。提出物の読み込みと照合の配線は Web/CLI にまたがり、`examBindingVerified` のように呼出側が検証済みの事実を渡す入口もある。外部アプリにこの配線の正しさを委ねない高水準 API が必要である。

`typingProof/replay.ts` の tolerant 適用は分類用で、不正イベントを黙って無視する仕様である。検証用の厳密 replay と共通 primitive を持つが、そのまま外部の履歴復元 API として成功扱いしてはいけない。コード実行ログは開始・結果を持つが stdout を記録しておらず、操作ログから実行環境全体を再現できるわけではない。

## Considered Options

| 案 | 利点 | 欠点 |
|---|---|---|
| shared の内部 export をそのまま利用させる | 初期工数が少ない | 内部変更が外部を壊し、検証の正しい順序を利用者が実装する |
| 公式の検証 HTTP API を作る | 呼出言語を問わない | ログ送信・運用・ネットワーク依存が増える |
| 公開 SDK を作り公式アプリも同じ入口を使う | ローカル/サーバーで再利用でき、仕様差を隠蔽できる | API と配布物の互換性を管理する責務が増える |

## Decision

`packages/verifier` に `@typedcode/verifier` を設ける。公式 verify/verify-cli はこの公開 API の利用者とし、外部アプリだけが使えない裏の検証経路を標準動作に残さない。公開サービスは作らず、compiled ESM JavaScript と型定義を配布する。

### 1. 高水準の検証入口

以下の呼出しは責務を示す例であり、正確な引数名と型は #811 で定義する。

```ts
const result = await verifySubmission(fileBytes, {
  examPackage,
  trustStore,
  signal,
});
const decision = evaluatePolicy(result, policy);
```

SDK は JSON/ZIP の構造検査、仕様の dispatch、問題署名・束縛、チェーン/PoSW/署名、同梱ソース・スクリーンショットの照合を組み立てる。複数 proof、壊れた proof、対応の曖昧さもファイル単位で返す。型付き引数を受け取っただけで安全な入力とみなさない。

外部の caller が `examBindingVerified: true` と申告するだけで検査を省略できる標準入口を作らない。低水準 API を公開する必要が生じた場合も、結果の実施範囲を保ち、高水準 API の確認済み状態を自己申告で作れないようにする。型ブランドだけで実行時の証拠を保証しない。

DOM、Monaco、localStorage、秘密鍵、公式 API への接続は不要とする。ファイルパスやブラウザの file handle は adapter が bytes に変換し、Worker/worker_threads での実行はホスト側へ分ける。SDK の import が勝手に CLI を起動したり状態を変更したりしない。

進捗、中断、入力サイズ・展開量・作業量の予算を契約に含める。過大な ZIP は展開後に気付くだけにせず、既存の展開予算を再利用する。中断を返した後も重い PoSW を走らせ続けないよう、協調的な処理区切りまたは Worker 停止で実効性を検証する。提出コードを実行して検証する方式にはしない。

### 2. 公開結果と信頼情報

対応状況、項目別結果、実施/省略/欠落、保証範囲、信頼評価、受理結果を別に返す (ADR-0053)。安定した機械用コードと元ファイル/イベントへの参照を持ち、利用者向け翻訳は Web/CLI/外部アプリへ任せる。単一の `valid` だけで full、fast、資料不足、未対応を表現しない。

検証本体は入力と明示された trust snapshot/評価時刻/方針で決定的に動く。公式の公開鍵情報は明示的に選べる既定セットとして配布できるが、隠れたネットワーク取得をしない。外部の署名者を信頼する独自運用も可能とする。任意同梱の公開鍵を自動的に信頼しない。

外部保存する結果には、結果 schema、SDK 版、対象原本の digest と対象範囲、検査の実施範囲、trust snapshot と policy の識別を残す。任意の JSON に `verified` があるだけで証拠とはみなさない。別のサービスが結果を信頼する場合は原本を再検証するか、別途定義した信頼できる検証者の署名が必要である。本 ADR では署名付き検証レポートのプロトコルを追加しない。

### 3. 再生 API と再現できる範囲

同一パッケージの `@typedcode/verifier/replay` 等の明示的な subpath で提供し、最初から多数の公開パッケージに分けない。暗号検証と再生は独立して呼べるが、再生結果に検証済みという状態を勝手に付けない。

| 対象 | 提供する範囲 |
|---|---|
| 文書状態 | 仕様に従って挿入・削除・置換・template/snapshot を適用し、event index 時点の内容を返す |
| イベントビュー | 原本の index と文書識別子に対応する共通表現。旧版にない情報は unavailable |
| 操作の間隔 | 記録された時刻を表示・再生に利用できるが、実時間の真正性を自動保証しない |
| 実行の流れ | 記録された開始・成功/失敗等を表示する。プログラムを再実行しない |
| 再現しないもの | 未記録の操作、stdout 全文、OS/ブラウザ画面全体、乱数/時刻/外部依存を含む実行結果 |

文書順序は記録された event index を正とし、同時刻や逆行する時刻で並べ替えない。UTF-16 offset、改行、複数変更、内部ペーストの監査 marker 等は仕様別に扱う。複数タブは独立した列であり、壁時計だけから厳密な横断順序を捏造しない。

標準の replay は適用不能なイベントを位置・理由とともに返す。不正な編集を黙って無視して「最後まで再現成功」にしない。部分表示を提供するなら明示的な選択と未完了範囲を返す。snapshot に達したからといって、その前に記録されていない編集過程を復元したとは扱わない。

未検証のログの閲覧はできる。検証済み入力と関連付ける場合は原本の対応と実施範囲を保持し、後から可変なデータを差し替えても検証済みと見えないよう snapshot/コピー等を用いる。元ファイルは変更せず、再生用の正規化は派生表現で行う。

### 4. 分析・データ最小化との境界

ログの整合性は、本人の理解や不正がないことの証明ではない。分析器は検証と別の advisory 層として維持する (ADR-0023)。外部サービス固有の採点・推奨・可視化を SDK コアへ入れない。

再生にはコードを含む生ログが必要になりうる。content-free な分析 bundle や集計から完全な編集履歴を復元できるとは説明しない。原本を redact して同じ証明として返さず、共有用の派生ビューを別物として示す。既存 Tier A は自由記述等を含み、匿名データという保証はない (ADR-0024 / #304)。SDK 自体はログを収集・送信しない。

### 5. 配布とテスト

- SDK の `package.json` を SDK API の SemVer の正本にする。アプリの版・ファイル仕様版とは独立させる。内部 workspace のライブラリすべてを npm 公開する必要はない。
- `exports` で検証・再生の公開入口を限定し、JS・型定義・README・ライセンス・必要な依存を配布する。公開 API にモノレポの相対パスを残さない。
- `npm pack` の成果物をリポジトリ外の Node/browser の最小アプリへ入れて検証・再生する。秘密鍵不要の公開 fixture と、ネットワーク遮断時の例を用意する。Node のサポート版は package の engines、browser は検査済みの対応表を正本にする。
- Web/CLI/外部サンプルに同じ入力・信頼情報・方針を渡し、検証結果と各 index の文書が一致することを確認する。既存の Web/CLI parity・凍結 proof を活かす。
- 他言語の最初の入口には CLI の schema 付き JSON 出力を提供する。仕様と固定ベクタは他言語実装にも使えるが、複数言語 SDK は今は作らない。
- npm の権限を確認して同一の検査済み tarball を公開する。資格情報や本番公開の確認を済ませたと推測しない。

新しい検査は関連 Issue の具体的な失敗例を根拠に、既存のテスト経路へ加える。Pact Broker、Schema Registry、常駐の互換性管理サービス、別の分析基盤を導入する条件にはしない。

## Consequences

### Positive

- 外部アプリは仕様別の暗号計算や編集適用を再実装せず、独自サービスへ集中できる。
- 公式アプリも公開 API を使うことで、外部だけが使いにくい API を避けられる。
- ログを公式サーバーへ送信せず、端末内・独自サーバーで検証できる。

### Negative / Trade-offs

- SDK API、型、配布物、結果 schema の互換性管理が新たな責務になる。
- 処理量の上限・中断と Node/browser の差異を配布物で確認する必要がある。
- 再生と信頼を区別した結果は単純な boolean より複雑だが、保証の過大表示を避けるため必要である。

### Follow-ups / 残課題

- [#811](https://github.com/shinyaoguri/typedcode/issues/811): 検証 SDK と公式 Web/CLI の統合。
- [#812](https://github.com/shinyaoguri/typedcode/issues/812): 再生 API・共通ビューと公式履歴表示の統合。
- [#813](https://github.com/shinyaoguri/typedcode/issues/813): 配布物・外部例・SDK 版管理と公開。
- 前提: [ADR-0053](0053-versioned-verification-contracts.md)、[#809](https://github.com/shinyaoguri/typedcode/issues/809)。アプリ配置は [ADR-0052](0052-independent-app-packages-and-deployments.md)。

## References

- [ADR-0021](0021-code-execution-result-capture.md)、[ADR-0023](0023-analysis-platform-not-judge.md)、[ADR-0024](0024-data-minimization-tiers.md)、[ADR-0043](0043-acceptance-policy-separated-from-integrity.md)
- [現行 shared API](../../packages/shared/src/index.ts)、[検証](../../packages/shared/src/verification.ts)、[replay primitive](../../packages/shared/src/typingProof/replay.ts)、[分析 bundle の限界](../../packages/shared/src/analysis/bundle.ts)
- [Node.js: package exports](https://nodejs.org/api/packages.html#package-entry-points)
- [Pact: 公開済み版との互換性確認](https://docs.pact.io/pact_broker/can_i_deploy) (考え方を参照し、Broker は導入しない)
