# ADR-0058: 復元で見つけたイベント列の飛びは、手前で記録を切り詰め、飛びより後を保全に写してから events から外す

- **Status**: Accepted
- **Date**: 2026-11-23
- **Deciders**: @shinyaoguri (#878 の 2026-11-23 の決定と、判断 1・2 のコメント)
- **PR / Commit**: (#878 を閉じる PR)

## Context

IndexedDB の events に sequence の飛び (`events[i].sequence !== events[i-1].sequence + 1`) が残ることがある。原因の 1 つ (contentSnapshot の保存漏れ) は #873 で塞いだが、保存の失敗・古い版が残した DB・未知の不具合では残りうる。これまでの復元は `console.error` を出して飛びをまたいだまま続けたので、利用者は気付かずに検証に通らない proof を提出していた (verify-cli は `Sequence mismatch at event N`)。

#878 の決定で、飛びの手前で記録を切り詰め、飛びより後のコードは #413 (ADR-0042 段階 2) と同じ `unprovenContents` に保全して知らせ、切り詰めた後もそのタブで続けられるようにすることになった。飛びより後のイベントを証明として救い出すことはしない。

続けるには、飛びより後のイベントの行を IndexedDB の events から外すしかない。行が残っていると、切り詰めた記録の続きの入力が同じ `(tabId, eventIndex)` の古い行と hash で食い違い (`EventChainConflictError`、不変条件 5)、保存も閉じたタブの保存 (`archiveTab`) も通らない。行が飛びを埋める形で混ざると、次の読み直しでは sequence は連続しているのに hash の連鎖が切れた記録になり、飛びの検査をすり抜けて黙って壊れる。

一方で ADR-0057 の決定 1 は「exam 以外では、利用者の明示の操作なしに、コードとイベントを IndexedDB から削除しない」とし、例外を置いていない。ADR は append-only なので、この例外はここに追補する。

## Considered Options

### Option A: 飛びより後のイベントを `unprovenContents` の行に写し、同じ transaction で events と `tabProgress` から外す

- Pros: データは失われない (コードもイベントも同じ DB に残る)。写すのと外すのが 1 つの transaction なので、途中で失敗しても何も変わらない。`unprovenContents` は追記のみのストアで、#413 と同じ置き場・同じ通知で済む。`DB_VERSION` を上げない (行に任意の欄を足すだけ)
- Cons: ADR-0057 の決定 1 に例外ができる。`unprovenContents` の行が大きくなる (外したイベントの数だけ)

### Option B: 飛びより後のイベントを保全せずに消す

- Pros: 実装が小さい。保存領域が増えない
- Cons: 記録が失われる。ADR-0057 の「失わない」(#306) に反する

### Option C: 行は残し、切り詰めたタブを新しい tabId に移して続ける (元のタブは閉じたタブとして残す)

- Pros: 何も消さない
- Cons: 利用者から見て「そのタブで続ける」にならない (tabId・署名の結びつきが変わる)。閉じたタブを開き直すと同じ切り詰めがもう一度起きる。変更が大きい

## Decision

**Option A** を採る。ADR-0057 の決定 1 への例外は、次の 1 つだけとする。

1. 復元 (sessionStorage からの読み直し・IndexedDB からの再開・閉じたタブの開き直し) で events に sequence の飛びを見つけたら、記録を最初の飛びの手前で切り詰める。チェックポイントは、残したイベントを指すものだけを残す (署名済みを含む)
2. 保存されていた content を `unprovenContents` に `reason: 'sequence-gap'` で、飛びより後のイベントを同じ行の `truncatedEvents` に写し、**同じ transaction で** そのイベントを events から、書き込み位置を `tabProgress` から消す (`SessionStorageService.preserveTruncatedEvents`)。写せなければ何も消さない。所有権を失ったインスタンスは消さない
3. 外したイベントは証明に戻さない (proof にも、救出が読むメモリ上の状態にも載せない)。以降の入力は、切り詰めた記録の続きとして同じタブに記録する
4. 写さずに消す経路と、飛び以外の理由で events を消す経路は作らない (exam の `deleteTab`・リセット・「完全に削除する」はこれまでどおり)

### 署名 (#878 の判断 2)

切り詰めた先を指す署名済みチェックポイントは proof から外す (残すと verifier が `points to missing event` で拒否する)。署名サービスは残った最後の署名から `checkpointIndex` を続けるので、サーバが記録している index と食い違い、そのタブの以後のチェックポイントは署名されない (409。チェックポイントごとに試行の上限まで再送して諦める)。この ADR では、切り詰めたタブの以後に時刻アンカーが付かないことを受け入れる。proof は検証を通る。署名の再開は別 Issue で扱う。

## Consequences

### Positive

- 飛びのある保存データから再開しても、提出した proof が検証を通る。利用者は通知で、切り詰めたことと元のコードの差分を知り、元のコードを取り出せる
- 飛びより後のコードもイベントも同じ DB に残る (消えるのはリセットで DB ごと消すときだけ)
- 切り詰めた記録の続きが保存でき、読み直しても続く

### Negative / Trade-offs

- ADR-0057 の決定 1 に例外ができる (events から行が消える経路が 1 つ増える)
- 飛びより後の記録は証明にならない (救い出さない)。その間の時刻アンカーも失われ、切り詰めたタブの以後も署名されない (上の「署名」)
- `unprovenContents` の行が、外したイベントの数だけ大きくなる (容量の扱いは ADR-0057 の残課題と同じ)
- 切り詰めを保存した後、tabs 行を書き直す前に閉じると、次の復元では tabs 行に古いチェックポイントが残る。これは復元が常に「残したイベントの外を指すチェックポイントを外す」ことで吸収する (飛びが無くても外す)

### Follow-ups / 残課題

- 切り詰めたタブの署名の再開 (サーバの `checkpointIndex` と食い違わない形で続ける)
- 先頭が 0 でない記録 (チェーンの根の欠落) は扱わない (`console.error` のまま)

## References

- Issue #878 (決定と判断 1・2) / #873 (飛びの原因の 1 つ) / #413 (元のコードの保全) / #306 (失わない) / #484・#237 (`EventChainConflictError`・所有権)
- ADR-0042 (段階 2) / ADR-0057 (決定 1 に例外を足す)
- `packages/editor/src/ui/tabs/restoredChain.ts` (`trimRestoredChain`)、`packages/editor/src/ui/tabs/TabManager.ts` (`restoreContent` / `trimRestoredEvents`)、`packages/editor/src/services/SessionStorageService.ts` (`preserveTruncatedEvents`)、`packages/editor/src/ui/dialogs/UnprovenContentDialog.ts`
- `packages/e2e/tests/restore-sequence-gap.spec.ts`
