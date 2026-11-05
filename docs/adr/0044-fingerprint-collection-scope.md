# ADR-0044: fingerprint の収集を用途のあるコンポーネントに絞る (canvas・fonts を集めず、WebGL は unmasked の 2 値だけ)

- **Status**: Accepted
- **Date**: 2026-11-05
- **Deciders**: メンテナ (#242 の D1〜D3 を 2026-11-01 に承認)
- **PR / Commit**: #242 を閉じる PR

## Context

TypedCode は個人を同定しないと明言している (system-spec §8.3「fingerprint は環境同定であってユーザ個人を識別するものではない」、試験モードは「ローカル完結・サーバ非依存・匿名」)。一方で fingerprint (`packages/shared/src/fingerprint.ts` の `collectComponents`) は 17 キーを集め、その中にブラウザ環境で最も同定力の高い信号を含んでいた。

- `canvas`: 200×50 の描画を `toDataURL()` した PNG の data URL 全文
- `fonts`: 18 フォントの有無
- `webgl`: `vendor` / `renderer` / `version` / `shadingLanguageVersion` / `unmaskedVendor` / `unmaskedRenderer` の 6 値

components は `fingerprintHash = SHA256(JSON(components))` の入力で、検証器が proof 同梱の components から hash を再計算するため、**Tier F の proof に平文で必ず入る**。ADR-0024 は fingerprint を Tier F に閉じ込めた (配らない) が、「収集はする」ままで、Follow-ups (`0024:78`) に「fingerprint 自体の最小化は別途検討余地」と宿題を残していた。収集範囲の根拠を書いた ADR はそれまで無かった。

fingerprint の用途と、そこに必要な同定力 (#242 のトリアージで実装から追った):

| 用途 | 実装 | components の同定力は要るか |
|---|---|---|
| チェーン root の構成 | `SHA256(fingerprintHash ‖ nonce …)` (ADR-0004 / 0006 / 0017) | 要らない。root の一意性は 256-bit の nonce (と serverNonce) が担い、検証は proof 内の自己整合 |
| 別 proof からの流用検出 | events と fingerprint ブロックの組み合わせの不一致 (system-spec §8.1) | 要らない。hash の等値比較で足りる。異なる proof 間で components を照合する UI は verify にも CLI にも無い |
| session start token の端末束縛 | `token.payload.fingerprintHash === fingerprintHash` | 要らない。混用防止であり、実機への束縛ではない |
| ヘッドレス GPU の検出 | `analysis/analyzers/automationAnalyzer.ts` が `webgl.unmaskedRenderer` を読む (advisory) | WebGL の renderer だけは使う |

canvas と fonts を読むコードはどこにも無い。

## Considered Options

### Option A: 現状のまま 17 キーを集め、理由だけ ADR に書く
- Pros: 変更ゼロ。旧 proof と新 proof の components の形がそろう
- Cons: 用途の無い高同定力の信号を、学生の提出物に入れ続ける。規約に挙げると「なぜ集めるのか」に答えられない

### Option B: 用途の無いものを落とす — canvas と fonts を集めず、WebGL は `unmaskedVendor` / `unmaskedRenderer` だけ (本 ADR)
- Pros: 最も同定力の高い 2 つ (canvas の描画差、フォント一覧) を proof から外せる。3 用途は hash の等値比較なので弱まらない。ヘッドレス検出は残る。検証器は特定のキーを要求しないので旧 proof の互換コストはゼロ
- Cons: 旧 proof と新 proof で components の形が違う (型は落としたキーを optional にして両方受ける)

### Option C: fingerprint 全体をやめ、root にはランダム値だけを入れる
- Pros: 環境情報を proof に一切入れない
- Cons: ヘッドレス検出 (ADR-0007 B 群) と、token の端末束縛 (ADR-0017) の入力が無くなる。root の式 (shared 不変条件) と proof 形式を変える破壊的変更になる。#242 の範囲を超える

## Decision

**Option B** を採る。新しい proof の fingerprint は次の 13 キーだけを集める。残すキーごとの理由:

| キー | 残す理由 |
|---|---|
| `userAgent` | HTTP リクエストで元々送っている値。ADR-0007 B 群 (自動化/環境) の基礎 |
| `language` / `languages` | HTTP の `Accept-Language` で元々送っている値 |
| `platform` | UA と同程度の粒度の OS 名。UA との矛盾が自動化の手掛かりになる (ADR-0007 B 群) |
| `hardwareConcurrency` / `deviceMemory` | ADR-0007 B 群に挙げた環境信号。粗い区分 (コア数・GB 単位) |
| `screen` | ADR-0007 D 群 (ディスプレイ)。ヘッドレスに多い既定解像度の手掛かり |
| `timezone` / `timezoneOffset` | ADR-0007 B 群 (`Intl` timezone) に挙げた環境信号。地域単位の粗い値 |
| `webgl.unmaskedVendor` / `webgl.unmaskedRenderer` | `automationAnalyzer` のヘッドレス GPU (SwiftShader 等) 検出 (ADR-0007 B 群の「headless tell」) |
| `cookieEnabled` / `doNotTrack` / `maxTouchPoints` | 1 ビット〜数値の粗い値。タッチ点数は入力経路 (ペン・タッチ) の解釈に使える |

集めなくしたもの:

- `canvas` — 描画結果の差は GPU・ドライバ・フォントレンダリングの組み合わせで端末をほぼ一意に絞る。読むコードが無い
- `fonts` — インストール済みフォントの一覧は端末の同定に効き、読むコードが無い
- `webgl.vendor` / `renderer` / `version` / `shadingLanguageVersion` — ブラウザがマスクした値と版文字列。ヘッドレス検出には unmasked の値で足り、UA と重なる

ルール:

1. **新しいコンポーネントは、読むコード (分析器・検証器) か、残す理由をこの表に足してから集める。** 理由を書けないものは集めない
2. **旧 proof は受け付け続ける。** 検証器は proof 同梱の components を再ハッシュするだけで、特定のキーを要求しない。`FingerprintComponents` の型では `canvas` / `fonts` を optional にし、旧形式を型で拒まない。新しい proof で集める形は `CollectedFingerprintComponents` で表す
3. **規約 (editor の利用規約モーダル) に、集めるキーを過不足なく列挙する。** 列挙は `terms.hashChainFingerprint` の 1 か所に置き、`terms.privacyBrowserInfo` はそこを指す。キーの増減は editor のテスト (`Record<keyof CollectedFingerprintComponents, …>`) が型エラーで知らせる

ADR-0024 の Follow-ups「fingerprint 自体の最小化 (Tier F 内でも採点に不要なコンポーネントを削るか)」は本 ADR で閉じる。ADR-0007 の「捕捉は最大」は、生信号を将来の分析器のために残す原則であり、本 ADR が落とすのは ADR-0007 の信号表 (A〜G 群) に載っておらず、どの分析器も読まない 2 つと、unmasked 値と重なる WebGL の 4 値に限る。

## Consequences

### Positive
- proof に入る端末情報から、最も同定力の高い canvas と fonts が消える。学生に「何を集め、なぜか」をキーごとに説明できる
- root・流用検出・token 束縛・ヘッドレス検出は変わらない
- proof 形式・検証器・旧 proof の検証結果は変わらない (shared の `fingerprintCompat.test.ts`、#581 の凍結 proof `frozenProofs.test.ts`、verify-cli の `valid.json`。凍結 proof と `valid.json` はどれも canvas・fonts を含む旧形式)

### Negative / Trade-offs
- 旧 proof (17 キー) と新 proof (13 キー) で components の形が違う。components を読むコードは optional chaining で両方を扱う必要がある
- 同じ端末でも、この変更の前後で `fingerprintHash` が変わる。fingerprint hash を proof をまたいで突き合わせる運用は無い (verify にも CLI にも照合 UI が無い) ので実害は無いが、外部で突き合わせている人がいれば前後で一致しなくなる

### Follow-ups / 残課題
- UA・screen など残したキーをさらに粗くする (例: 解像度の丸め) かは、読む分析器の要求が出てから判断する (#242 のスコープ外)

## References

- `packages/shared/src/fingerprint.ts` (`collectComponents` / `getWebGLFingerprint`)
- `packages/shared/src/types/fingerprint.ts` (`FingerprintComponents` / `CollectedFingerprintComponents`)
- `packages/shared/src/analysis/analyzers/automationAnalyzer.ts` (`webgl.unmaskedRenderer` の唯一の消費者)
- `packages/editor/src/i18n/translations/{ja,en}.ts` (`terms.hashChainFingerprint` / `terms.privacyBrowserInfo`)
- ADR-0007 (生信号の捕捉)、ADR-0017 (session start token)、ADR-0024 (データ最小化ティア)
- Issue #242 (判断の経緯と D1〜D3)、#412 (使われない端末 ID の削除)、#581 (proof の凍結。凍結 proof は旧形式の fingerprint を持つ)
