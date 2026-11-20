/**
 * 起動時に前のセッションを再開しないときの、新しいセッションの始め方 (#317)。
 *
 * exam 以外では、利用者の明示の操作 (復旧ダイアログの「完全に削除する」と、設定メニューのリセット) なしに
 * コードと記録を消さない。「新規」の既定 (前のセッションを残す) は前のセッションの開いているタブを閉じたタブ
 * (`archived`) にするだけで、events・位置・スクリーンショットは残す。残したタブはメインメニューの「閉じたタブ」から
 * 開き直せる。exam は従来どおり全ストアを消す (`clearSession`)。
 */

import type { SessionMetadata } from '@typedcode/shared';
import type { SessionStorageService } from '../services/SessionStorageService.js';

/**
 * 前のセッションをどう扱うか。
 * - `keep`: 前のセッションの開いているタブを閉じたタブにして残す (exam 以外の既定)
 * - `delete`: `clearSession` で全ストアを消す (「完全に削除する」と exam)
 */
export type PreviousSessionDisposition = 'keep' | 'delete';

/**
 * 前のセッションを `disposition` どおりに片付けて、新しいセッションを作る。
 *
 * `keep` で閉じたタブにする書き込みが失敗したら、新しいセッションを作らずに reject する (消してはいないので
 * 前のセッションはそのまま残る。呼び出し側は起動失敗として扱う)。
 */
export async function startNewSession(
  sessionService: Pick<SessionStorageService, 'archiveSessionTabs' | 'clearSession' | 'createSession'>,
  previousSessionId: string | null,
  disposition: PreviousSessionDisposition,
  now: () => number = Date.now
): Promise<SessionMetadata> {
  if (disposition === 'delete') {
    await sessionService.clearSession();
  } else if (previousSessionId) {
    await sessionService.archiveSessionTabs(previousSessionId, now());
  }
  return sessionService.createSession();
}
