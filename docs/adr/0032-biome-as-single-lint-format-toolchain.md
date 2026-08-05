# ADR-0032: lint / format を Biome 1 つに集約し品質ゲートを typecheck 以外へ広げる

- **Status**: Accepted
- **Date**: 2026-08-05 (決定・実装は 2026-07 の #157 / PR #185。事後に ADR 化)
- **Deciders**: @shinyaoguri
- **PR / Commit**: [#185](https://github.com/shinyaoguri/typedcode/pull/185) (Issue [#157](https://github.com/shinyaoguri/typedcode/issues/157)) / `794158a` `d2d5ee4`

## Context

2026-07 の多角レビュー時点で、本リポには eslint / prettier / biome / .editorconfig のいずれも存在せず、CI の品質ゲートは `typecheck` だけだった。tsconfig の `noUnusedLocals` などが一部を代替していたが、次が人力と AI の規律頼みになっていた。

- スタイル統一 (インデント・引用符・末尾カンマ) — レビューで毎回指摘するコスト
- import 整理・浮遊 Promise の検出
- Dependabot PR の差分ノイズ (整形差分が実質的な変更に混ざる)

制約は 3 つ。(1) monorepo で 6 パッケージあり、設定を 6 か所にコピペしたくない (tsconfig が既にそうなっていた)。(2) 本リポは暗号証明が本題で、ツールチェーンの維持に割ける時間が小さい。(3) CI 時間は E2E ([ADR-0033](0033-e2e-round-trip-harness-as-deploy-gate.md)) が既に支配的なので、lint に秒を積み増したくない。

## Considered Options

### Option A: ESLint + Prettier (+ typescript-eslint)

- Pros: 事実上の標準でルール資産・プラグイン (import 順、`no-floating-promises` など) が最も厚い。型情報つき lint ができる
- Cons: 依存が 3 系統に増え、ESLint と Prettier の責務境界の調停 (eslint-config-prettier など) が要る。flat config 移行の追随コスト。型情報つき lint は monorepo で目に見えて遅い

### Option B: Biome 1 つ (lint + format)

- Pros: 単一バイナリで lint と format を兼ね、設定は root の `biome.json` 1 つ。高速で CI に足す秒数が小さい。`biome check --write` が安全な自動修正と format を同時に行い、手作業の整形差分が消える
- Cons: ルール資産は ESLint より薄く、型情報を要するルール (浮遊 Promise の完全検出など) は守備範囲外。エコシステムが若く、破壊的変更を踏む可能性がある

### Option C: 現状維持 + `.editorconfig` だけ置く

- Pros: 導入コストゼロ。エディタ側の最低限の統一はできる
- Cons: CI で強制できないため実質的な品質ゲートにならない。import 整理・自動修正は得られず、レビューでの指摘コストが残ったまま

## Decision

**Option B (Biome 1 つ)** を採る。決め手は「ツールチェーンに割ける時間が小さい」という制約で、設定 1 ファイル・依存 1 つ・`npm run lint` = `biome ci .` の 1 コマンドという運用の軽さが、ルール網羅性の不足を上回ると判断した。

型情報つきルールが要る領域 (浮遊 Promise など) は、`tsconfig.base.json` を root に新設して 6 か所コピペの tsconfig を `extends` 化し、コンパイラ側の厳格化 (`noUnusedLocals` / `noUncheckedIndexedAccess` など。workers は欠落していたため段階的に揃える) で補う。lint と型検査の役割をこう分けたので、`.editorconfig` は置かない (format の正本を Biome に一本化し、二重定義の食い違いを作らない)。

## Consequences

### Positive

- CI の `check` job が「typecheck → lint (Biome) → build → Worker config dry-run」に広がり、品質ゲートが typecheck だけではなくなった
- 整形は `npm run lint:fix` (`biome check --write`) で決定論的に揃うため、レビューがスタイル指摘から解放された
- 設定が root の `biome.json` 1 つに集約され、パッケージ追加時に lint 設定を書かなくてよくなった

### Negative / Trade-offs

- 型情報を要する lint ルールは使えない。浮遊 Promise などは tsconfig の厳格化とレビューで拾う前提が残る
- Biome の破壊的変更に追随するコストを負う (Dependabot の dev-dependencies group で上がってくる)
- 導入時に `d2d5ee4` の機械的 format コミットが入り、その範囲で `git blame` が 1 段深くなった

### Follow-ups / 残課題

- `scripts/` 配下に既存の warning が残っている (lint は green だが info / warn は出る)。ルールを上げるか個別に潰すかは未決
- workers の tsconfig 厳格化は段階的に進める方針で、完了していない

## References

- Issue [#157](https://github.com/shinyaoguri/typedcode/issues/157) — lint/format 設定が一切ない (品質ゲートが typecheck のみ)
- `biome.json`, `tsconfig.base.json`
- [.github/workflows/deploy.yml](../../.github/workflows/deploy.yml) — `check` job の Lint & format check ステップ
- [ADR-0033](0033-e2e-round-trip-harness-as-deploy-gate.md) — もう一方の品質ゲート (E2E)
