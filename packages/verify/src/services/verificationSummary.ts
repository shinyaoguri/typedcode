/**
 * 複数 proof の検証結果の集約 (#282)。ステータスバーの `N/M passed` と data-proof-* の元になる純関数。
 *
 * 入力は `VerificationController` がタブに流した `status` だけを見る。検証結果 (`verificationResult`) から
 * 導出し直さない: Sidebar / TabBar と食い違う余地ができるのと、検証キューに載らない読めない
 * `*_proof.json` (#292。`status: 'error'` のタブ) が抜け落ちるため。
 * `passed` は CLI の summary の `valid` と同じ軸で、警告は passed に数える (error だけが failed)。
 * `cancelled` (利用者が検証を止めた = 未検証。#331) は passed にも failed にも入れず別に数え、`done` の判定では
 * 「済み」に入れる (入れないとステータスバーが検証中のまま止まる)。
 */
import type { VerifyTabState } from '../types.js';

export interface VerificationSummary {
  /** proof のタブの数 (plaintext・画像は含まない)。 */
  total: number;
  /** status が success / warning の数。 */
  passed: number;
  /** status が error の数。 */
  failed: number;
  /** status が cancelled (未検証のまま止めた) の数。passed にも failed にも入らない。 */
  cancelled: number;
  /** pending / verifying の proof が残っていなければ true (cancelled は済みに数える)。proof が 0 件でも true。 */
  done: boolean;
  /** 最初に失敗した proof のタブ ID (表示順)。失敗が無ければ null。 */
  firstFailedId: string | null;
}

export function summarizeVerification(
  tabs: ReadonlyArray<Pick<VerifyTabState, 'id' | 'status' | 'isPlaintext' | 'isImage'>>
): VerificationSummary {
  const summary: VerificationSummary = {
    total: 0,
    passed: 0,
    failed: 0,
    cancelled: 0,
    done: true,
    firstFailedId: null,
  };
  for (const tab of tabs) {
    if (tab.isPlaintext || tab.isImage) continue;
    summary.total++;
    switch (tab.status) {
      case 'success':
      case 'warning':
        summary.passed++;
        break;
      case 'error':
        summary.failed++;
        summary.firstFailedId ??= tab.id;
        break;
      case 'cancelled':
        summary.cancelled++;
        break;
      default:
        summary.done = false;
    }
  }
  return summary;
}
