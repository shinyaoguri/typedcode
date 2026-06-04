# Architecture Decision Records (ADR)

このディレクトリは、本プロジェクトで下された設計判断とその根拠を **append-only** で蓄積する場所です。コードは「どうなっているか」を語りますが、ADR は「**なぜそうなっているか**」を語ります。

## なぜ ADR を書くか

- AI エージェントが過去の議論をやり直さなくて済む (settled な判断を context として与えられる)
- 半年後の自分 / 新しい貢献者が経緯を辿れる
- 「コードを読めば分かる "What"」ではなく「コードを読んでも分からない "Why"」を記録する

## 何を書くべきか

- **新規追加で書く**: 複数の選択肢があり、片方を選んだ重要な判断 (アルゴリズム選択、互換性方針、フォーマット決定、責務分担)
- **書かなくてよい**: 自明なリファクタ、命名変更、軽微なバグ修正
- **判断基準**: 「6 ヶ月後にこの判断を覆そうとした人が、当時の議論を見ずに同じ結論に達するか?」が NO なら ADR にする

## 書き方

1. [`template.md`](template.md) をコピーして `NNNN-kebab-case-title.md` で保存
2. NNNN は連番 (4 桁 zero-padded)。既存最大 + 1
3. 1 ADR = 1 判断。複数の判断を 1 ファイルにまとめない
4. **コードと同じ PR で commit**。ADR と実装がアトミックに進む

## 改廃

- ADR は **append-only**。既存 ADR を編集しない (誤字脱字を除く)
- 判断を覆すときは **新しい ADR を追加し、旧 ADR の Status を `Superseded by ADR-NNNN` にする**
- 「やめた」場合は `Status: Deprecated` で残す

## 既存 ADR

| # | Status | Title |
|---|---|---|
| [0001](0001-hybrid-checkpoint-trigger.md) | Accepted | チェックポイントトリガをハイブリッド (events OR elapsed time) にする |
| [0002](0002-signed-checkpoints-with-ecdsa-p256.md) | Accepted | 署名済みチェックポイントは ECDSA-P256 + append-only 鍵レジストリ |
| [0003](0003-idempotent-signing-retry.md) | Accepted | 署名 API は内容ベースの冪等性で再送を吸収する |
| [0004](0004-verifier-checkpoint-stance.md) | Accepted | 検証側は未署名 cp の sampling を成功条件にしない |
| [0005](0005-input-type-policy.md) | Accepted | 許可/禁止 InputType の方針 |

## 参考

- [ADR の元になった Michael Nygard の記事](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
- [docs/system-spec.md](../system-spec.md) — コード挙動の仕様 (What)
- 各 `packages/*/CLAUDE.md` — サブシステムの責務と不変条件
