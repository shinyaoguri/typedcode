/**
 * 閉じたタブ (#317) のモード別の扱いと、メインメニューの「閉じたタブ」(`#closed-tabs-btn`) の配線。
 *
 * exam 以外では、タブを閉じる・テンプレートを取り込む・復旧ダイアログで「新規」→「前のファイルを残す」を選ぶと、
 * タブは IndexedDB に閉じたタブ (`archived`) として残る。メニューの一覧から今のセッションへ開き直せる
 * (前のセッションのタブも)。消えるのは「完全に削除する」とリセットのときだけ。exam は従来どおり削除し、
 * メニューの項目も出さない。
 */

import type { AppContext } from '../core/AppContext.js';
import type { EditorMode } from '../core/mode.js';
import { t } from '../i18n/index.js';
import type { ArchivedTabSummary } from '../services/SessionStorageService.js';
import { showClosedTabsDialog } from '../ui/dialogs/ClosedTabsDialog.js';
import type { ClosedTabPolicy } from '../ui/tabs/TabManager.js';
import { hideWelcomeScreen } from './WelcomeScreenHandler.js';

/** 閉じたタブの IndexedDB の行を残すか消すか。exam だけ消す (#317 の D4) */
export function closedTabPolicyFor(mode: EditorMode): ClosedTabPolicy {
  return mode === 'exam' ? 'delete' : 'archive';
}

/**
 * 最後のタブを閉じたときに、そのセッションのスクリーンショットを消すか。exam 以外は消さない (#317。利用者の
 * 明示の操作なしに記録を消さない)。exam はタブロックで閉じられないが、扱いは従来どおり消す側に残す
 */
export function shouldClearScreenshotsWhenAllTabsClosed(mode: EditorMode): boolean {
  return mode === 'exam';
}

export interface ClosedTabsMenuDeps {
  notify: (message: string) => void;
  /** 開き直したタブの表示を整える (ログビューアの初期化と、復元で証明と食い違った編集の通知) */
  afterReopen: () => void;
}

/**
 * メインメニューの「閉じたタブ」を配線する。exam では項目を DOM から取り除く (exam は閉じたタブを残さない)。
 */
export function setupClosedTabsMenu(ctx: AppContext, deps: ClosedTabsMenuDeps): void {
  const button = document.getElementById('closed-tabs-btn');
  if (!button) return;
  if (closedTabPolicyFor(ctx.mode) !== 'archive') {
    button.remove();
    return;
  }

  button.addEventListener('click', async () => {
    ctx.mainMenuDropdown.close();
    const tabManager = ctx.tabManager;
    if (!tabManager) return;

    let tabs: ArchivedTabSummary[];
    try {
      tabs = await tabManager.listArchivedTabs();
    } catch (e) {
      console.error('[ClosedTabs] Could not list closed tabs:', e);
      deps.notify(t('closedTabs.loadFailed'));
      return;
    }

    await showClosedTabsDialog(tabs, {
      notify: deps.notify,
      reopen: async (tabId) => {
        const tab = await tabManager.reopenArchivedTab(tabId);
        if (!tab) return false;
        // タブ 0 本のウェルカム画面から開き直したときは、エディタに戻してキャプチャを再開する
        hideWelcomeScreen(ctx);
        ctx.trackers.screenshot?.setCaptureEnabled(true);
        ctx.tabUIController?.updateUI();
        deps.afterReopen();
        return true;
      },
    });
  });
}
