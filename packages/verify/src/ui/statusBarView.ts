/**
 * ステータスバーの `#queue-status` に何を出すかを決める (#282 / #683)。集約 (data-proof-*) を出すのはここだけ。
 *
 * 優先順位は 検証中 > 集約 (全件済み・proof 1 件以上) > 操作メッセージ > Ready。
 * 操作メッセージ (フォルダを開いた・監視でファイルが変わった など) は一時的な知らせなので、集約を出せるときは
 * 集約を優先する。メッセージで集約を上書きすると、集約を出し直す契機 (検証の完了) がもう来ないことがあり、
 * 集約が消えたまま残る (#683: フォルダを開く処理の末尾より先に検証が終わった場合)。
 */
import { summarizeVerification } from '../services/verificationSummary';
import type { VerifyTabState } from '../types';
import type { StatusBarUI } from './StatusBarUI';

export function renderStatusBar(
  statusBar: Pick<StatusBarUI, 'setVerifying' | 'setSummary' | 'setMessage' | 'setReady'>,
  tabs: readonly VerifyTabState[],
  progress: { completedCount: number; totalCount: number },
  message?: string
): void {
  // TabManagerの状態に基づいて検証中かどうかを判定
  const verifying = tabs.some((tab) => tab.status === 'pending' || tab.status === 'verifying');
  if (verifying) {
    statusBar.setVerifying(progress.completedCount, progress.totalCount);
    return;
  }

  // 検証が全件済んだら件数を残す (#282)。自動で開くのは 1 件だけなので、赤い proof を見落とさないため。
  // 入力はタブの status (VerificationController が流した値) だけ。proof が 0 件 (plaintext のみ等) なら Ready。
  const summary = summarizeVerification(tabs);
  if (summary.done && summary.total > 0) {
    statusBar.setSummary(summary);
  } else if (message !== undefined) {
    statusBar.setMessage(message);
  } else {
    statusBar.setReady();
  }
}
