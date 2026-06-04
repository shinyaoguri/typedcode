## Summary

<!-- 何を / なぜ変えたか。1-3 行で。 -->

## Test plan

<!--
チェックボックスで「やったこと」を列挙する。
未テストなら理由を明記する。
-->

- [ ] `npm run check-docs` — ドキュメント乖離なし
- [ ] `npm run build` — 全パッケージビルド成功
- [ ] `npm run test:run -w @typedcode/shared` — shared テストすべて pass (fingerprint 20 件失敗は既知問題)
- [ ] 手動動作確認 (該当する場合は内容を記載)

## Documentation impact

<!--
コード変更に伴うドキュメント更新の自己チェック。該当しない項目は外す。
"docs と code が同じ PR に乗っている" 状態を目指す。
-->

- [ ] **不変条件を変えた** → 該当する `packages/*/CLAUDE.md` を更新した
- [ ] **設計判断をした** (アルゴリズム選択 / 互換性方針 / フォーマット決定 / 責務分担) → `docs/adr/` に ADR を追加した
- [ ] **定数値を変えた** (PoSW 反復数、cp トリガ閾値、フォーマットバージョン等) → `docs/system-spec.md` と関連 README を更新した
- [ ] **新しい EventType / InputType を追加した** → `types/events.ts`、`InputTypeValidator.ts`、関連 README、CLAUDE.md を同時に更新した
- [ ] **公開 API を変えた** → 該当パッケージの README を更新した
- [ ] **環境変数 / シークレットを追加した** → 該当 CLAUDE.md と README を更新した
- [ ] 上記いずれも該当なし

## ADR (該当する場合)

<!--
新しい ADR を追加した場合、ファイル名と要約を記載。
-->

- [ ] N/A
- ADR-NNNN: ...

## Related issues / PRs

<!-- 関連する issue や PR の番号。 -->

---

<details>
<summary>Reviewer 向けチェック</summary>

- [ ] 変更されたサブシステムの `packages/*/CLAUDE.md` を読み、PR の変更が不変条件と整合するか確認した
- [ ] 「なぜ?」が ADR またはコミットメッセージで説明されているか確認した
- [ ] 破壊的変更がある場合、`PROOF_FORMAT_VERSION` / `STORAGE_FORMAT_VERSION` の bump を検討した

</details>
