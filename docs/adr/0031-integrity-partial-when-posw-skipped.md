# ADR-0031: 検証モードで省略した検査を整合性層に反映する (integrity に `partial` を追加)

- **Status**: Accepted
- **Date**: 2026-08-05
- **Deciders**: (PR 上の合意者 / レビュアー)
- **PR / Commit**: #253 (ADR-0020 の integrity 値域を拡張)

## Context

ADR-0020 は保証を三層 (整合性 × 時刻アンカー × 著述性) で機械導出すると決め、そのうち
**整合性を「暗号検証、決定的、二値 (proven/failed)」** と定義した。この定義は「検証器は常に
全レイヤを実行する」という暗黙の前提のうえに立っている。

しかし検証器には `fast` / `audit` / `full` の 3 モードがあり (`docs/system-spec.md` §6.1)、
**`fast` は PoSW の反復再計算 (1 event あたり 10,000 回の SHA-256) を実行しない**。
spec §8.2 はこれを正直に書いている:

> `fast` モード: PoSW の正しさは検証されない。…**ただし「実際に 10000 回反復したか」は確認しない**

にもかかわらず、実装は fast でも整合性を `proven` と表示していた (2026-08 のレビューで
Issue #214 として検出)。`TrustCalculator` は `poswMode` を見ず issue を 1 件も積まず、
`deriveAssurance` の入力にも「PoSW を省略した」という情報が渡っていなかった。

これは本プロダクトが最も避けるべき失敗、すなわち **実際より強い保証を表示する overclaim**
である。とくに verify (web) のモードトグルは `fast → audit → full` を巡回するため、採点者が
気付かず fast のまま複数の提出物を流すと、全件が「検証成功・整合性: 証明済み」になる。

「整合性は二値」という ADR-0020 の規定と、「fast では一部の検査を実行しない」という spec の
規定が両立しないことが問題の根であり、どちらかを改める判断が要る。

## Considered Options

### Option A: fast モードでも `proven` のままにし、別枠 (warning) で注意書きだけ出す
- Pros: ADR-0020 の「二値」を維持できる。変更が表示層だけで閉じる。
- Cons: **overclaim が残る**。バッジは一覧性のために存在するのに、その一覧で嘘をつき、
  注記を読んだ人だけが真実に辿り着く構造になる。ADR-0020 自身が排除しようとした
  「単一の verdict に圧縮して誤読させる」構造の再生産。

### Option B: fast モードでは整合性を `failed` にする
- Pros: 二値を維持したまま overclaim を避けられる。
- Cons: **別種の誤情報を生む**。fast でも改ざん検出 (チェーン再計算・content replay・
  署名 cp 検証) は成立しており、「改ざんの疑いあり」と読める表示は事実に反する。
  正直な提出物を誤って告発する方向の誤りで、A とは逆向きだが同じくらい悪い。

### Option C: 整合性に `partial` を足し、省略した検査があるときに使う ★採用
- Pros: 「実施していない検査がある」を、「改ざんの疑い」とも「完全に証明済み」とも
  区別して表現できる。`temporal` が既に `partial` を「証拠はあるが弱い」の意味で
  使っており、同一モジュール内の語彙と整合する。ADR-0020 の**原則** (実証拠のみから
  機械導出し、強度差を一目で伝える) にはむしろ忠実。
- Cons: ADR-0020 の「二値」という明文と食い違うため、本 ADR で明示的に改める必要がある。
  表示側 (web バッジ・CLI・i18n ja/en) の値が 1 つ増える。

### Option D: fast モードを廃止して常に full で検証する
- Pros: 保証の語彙を増やさずに問題が消える。
- Cons: full は 1000 events で 10〜60 秒かかる。採点者が数十人分を回す現実的な運用を
  壊す。fast には「速い改ざん検出」という正当な用途があり、それ自体は嘘ではない。

## Decision

**Option C を採用する。** `IntegrityLevel` を `'proven' | 'partial' | 'failed'` に拡張し、
暗号検査に失敗していなくても **省略した検査があるときは `proven` に上げない**。

導出の優先順は `failed` > `partial` > `proven` とする。改ざん検出は fast でも成立するため、
チェーン破損・スクショ改竄・exam 束縛失敗は fast でも `failed` のままになる。

`AssuranceInput.poswSkipped` は **optional にせず必須**とする。optional にすると渡し忘れが
「未検証なのに proven」= 本 Issue そのものに倒れるためで、`chainImageHashes` を必須化した
のと同じ理由 (`packages/verify/CLAUDE.md` 不変条件 7)。`screenshotsTampered` と違い
「未検査」という第三の状態が存在しない点も根拠になる。

**ADR-0020 は本件を除きすべて有効**である。三層の構成・直交性・provenance が常に advisory
であること・`verifyProofFile` の valid を置き換えないことは変わらない。本 ADR が改めるのは
integrity の値域だけで、`temporal` / `provenance` の意味には触れない。

## Consequences

### Positive
- fast モードの表示が spec §8.2 の記述と一致し、overclaim が解消される。
- 「実施していない検査がある」と「改ざんの疑いがある」が表示上で区別される。
- `poswSkipped` が必須引数なので、将来モードを増やしても「渡し忘れて proven」が起きない。
- web と CLI の双方で同じ値になることを `webCliParity.test.ts` が CI で固定する
  (片側だけ直すとパリティテストが赤くなることを実測で確認済み)。

### Negative / Trade-offs
- ADR-0020 の明文 (「二値 (proven/failed)」) を本 ADR で改めるため、ADR-0020 単体を読んだ
  人が古い規定を信じる余地が残る。ADR-0020 の Status に本 ADR への参照を付けて緩和する。
- 保証バッジの取りうる値が 1 つ増え、表示・i18n (ja/en)・型の同期対象が広がる。
- `partial` は「弱い」ことしか言わないので、**何を省略したか**は別途 (warning issue /
  CLI の PoSW 行) で伝える必要がある。バッジ単体では読み切れない。

### Follow-ups / 残課題
- `audit` モードは現状 `full` と同等の実装 (spec §6.1)。将来 spec どおり決定的サンプリングを
  実装した場合、「一部だけ検証した」状態をどう表すかを再検討する (`partial` の再利用が
  自然だが、サンプリング率の提示が要るかもしれない)。
- 同種の「省略した検査」が他に生まれたときは、本 ADR の規則 (省略があれば `proven` に
  上げない) をそのまま適用する。

## References

- [ADR-0020](0020-three-layer-assurance-vocabulary.md) — 三層語彙の原典 (integrity の値域を本 ADR で拡張)
- [ADR-0009](0009-pluggable-analysis-layer.md) / [ADR-0023](0023-analysis-platform-not-judge.md) — advisory の直交性 (本 ADR で変更なし)
- `packages/shared/src/assurance.ts` — `deriveAssurance` の導出規則
- `packages/verify/src/services/__tests__/webCliParity.test.ts` — web↔CLI の結論一致を固定 (#216)
- `docs/system-spec.md` §6.1 (検証モード) / §8.2 (fast モードの弱い保証)
- Issue #214 / PR #253
