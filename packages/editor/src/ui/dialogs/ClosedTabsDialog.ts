/**
 * ClosedTabsDialog - 閉じたタブの一覧 (#317)
 *
 * exam 以外でタブを閉じる・テンプレートを取り込む・復旧ダイアログで「新規」→「前のファイルを残す」を選ぶと、
 * タブは IndexedDB に閉じたタブ (`archived`) として残る。このダイアログはそれを閉じた時刻の新しい順に並べ、
 * 選んだタブを今のセッションへ開き直す (`TabManager.reopenArchivedTab`)。前のセッションのタブも開き直せる。
 *
 * 状態契約 (packages/editor/AGENTS.md): overlay に `data-dialog="closed-tabs"` と `data-count` (一覧の件数)。
 * 行 (`.closed-tab-item`) に `data-tab-id` / `data-filename` / `data-language` / `data-archived-at` (epoch ms) /
 * `data-event-count`、行の中の「開き直す」は `data-action="reopen"`。閉じるボタンは `data-action="close"`。
 */

import { escapeHtml } from '@typedcode/shared';
import { t } from '../../i18n/index.js';
import type { ArchivedTabSummary } from '../../services/SessionStorageService.js';
import { showModal } from '../components/Modal.js';
import { tabFullFilename } from '../tabs/TabUIController.js';

export interface ClosedTabsDialogDeps {
  /** 閉じたタブを開き直す。開けたら true (ダイアログを閉じる)、開けなければ false (一覧に残す) */
  reopen: (tabId: string) => Promise<boolean>;
  /** 開き直せなかったことを知らせる */
  notify: (message: string) => void;
  /** 閉じた時刻の表示 (テストで固定する) */
  formatTime?: (epochMs: number) => string;
}

function defaultFormatTime(epochMs: number): string {
  const date = new Date(epochMs);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * 一覧を出す。閉じると resolve する。開き直せたらダイアログを閉じる (開いたタブがアクティブになる)。
 */
export async function showClosedTabsDialog(
  tabs: readonly ArchivedTabSummary[],
  deps: ClosedTabsDialogDeps
): Promise<void> {
  const formatTime = deps.formatTime ?? defaultFormatTime;

  const listHtml = tabs
    .map((tab) => {
      // タブに見えていた名前 (拡張子込み。タブの `data-filename` と同じ表現 = `tabFullFilename`)
      const filename = tabFullFilename(tab);
      const meta = t('closedTabs.itemMeta', {
        language: tab.language,
        count: tab.eventCount,
        time: formatTime(tab.archivedAt),
      });
      return `
        <li class="closed-tab-item" data-tab-id="${escapeHtml(tab.id)}"
            data-filename="${escapeHtml(filename)}"
            data-language="${escapeHtml(tab.language)}"
            data-archived-at="${tab.archivedAt}"
            data-event-count="${tab.eventCount}">
          <span class="closed-tab-text">
            <span class="closed-tab-name"><i class="fas fa-file-code" aria-hidden="true"></i> ${escapeHtml(filename)}</span>
            <span class="closed-tab-meta">${escapeHtml(meta)}</span>
          </span>
          <button type="button" class="modal-btn modal-btn-primary" data-action="reopen">
            <i class="fas fa-rotate-left" aria-hidden="true"></i> ${t('closedTabs.reopen')}
          </button>
        </li>
      `;
    })
    .join('');

  const body =
    tabs.length === 0
      ? `<p class="closed-tabs-empty">${t('closedTabs.empty')}</p>`
      : `<ul class="closed-tabs-list">${listHtml}</ul>`;

  const closed = showModal({
    title: t('closedTabs.title'),
    icon: 'fa-box-archive',
    variant: 'info',
    className: 'closed-tabs-dialog',
    dialogName: 'closed-tabs',
    closeOnOverlayClick: true,
    closeOnEscape: true,
    content: `
      <p class="closed-tabs-description">${t('closedTabs.description')}</p>
      ${body}
    `,
    buttons: [{ text: t('closedTabs.close'), type: 'cancel', action: 'close' }],
  });

  // showModal は overlay を同期で DOM に足す。最後に足された同名の overlay がこの呼び出しのもの
  const overlays = document.querySelectorAll<HTMLElement>('[data-dialog="closed-tabs"]');
  const overlay = overlays[overlays.length - 1];
  if (overlay) {
    overlay.dataset.count = String(tabs.length);
    const closeButton = overlay.querySelector<HTMLButtonElement>('.modal-footer [data-action="close"]');
    const reopenButtons = Array.from(overlay.querySelectorAll<HTMLButtonElement>('[data-action="reopen"]'));

    overlay.querySelectorAll<HTMLElement>('.closed-tab-item').forEach((row) => {
      const tabId = row.dataset.tabId;
      const button = row.querySelector<HTMLButtonElement>('[data-action="reopen"]');
      if (!tabId || !button) return;
      button.addEventListener('click', async () => {
        // 開き直している間は全行の「開き直す」を止める (二度押し・別の行との並走をさせない)
        for (const el of reopenButtons) el.disabled = true;
        let reopened = false;
        try {
          reopened = await deps.reopen(tabId);
        } catch (e) {
          console.error('[ClosedTabs] Could not reopen the closed tab:', e);
        }
        if (reopened) {
          // 閉じる経路は showModal の 1 つにまとめる (a11y の片付けとフォーカスの復帰を通す)
          closeButton?.click();
          return;
        }
        for (const el of reopenButtons) el.disabled = false;
        button.focus();
        deps.notify(t('closedTabs.reopenFailed'));
      });
    });
  }

  await closed;
}
