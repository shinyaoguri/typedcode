/**
 * UnprovenContentDialog - 復元時に証明と食い違った元のコードの通知 (#413。ADR-0042 段階 2)
 *
 * PoSW の処理待ちが残ったまま閉じると、その打鍵は証明に載らない。復元はエディタを証明の版にして
 * proof を valid に保ち、元のコードは IndexedDB の `unprovenContents` に保全する (`TabManager`)。
 * このダイアログはそれを知らせ、タブごとに差分 (読み取り専用) と元のコードのダウンロードを開ける。
 *
 * 文言は「末尾 N 文字」ではなく「元 X 文字 → 証明 Y 文字」: 処理待ちが途中の編集や削除だと、差分は
 * 末尾に限らず、元のほうが短いこともある。
 *
 * 状態契約 (packages/editor/AGENTS.md): overlay に `data-dialog="unproven-content"`。タブごとの行
 * (`.unproven-item`) に `data-tab-id` / `data-original-length` / `data-chain-length`、ボタンに
 * `data-action="show-diff" | "download"`。差分の置き場 (`.unproven-diff`) の `data-diff-tab-id` は
 * 表示中の差分のタブ id (表示していなければ空文字)。
 */

import { createExportNamer, escapeHtml } from '@typedcode/shared';
import { t } from '../../i18n/index.js';
import { showModal } from '../components/Modal.js';
import type { RestoreDivergence } from '../tabs/TabManager.js';

/** 差分の表示 (Monaco の diff editor。テストでは差し替える) */
export interface DiffView {
  dispose(): void;
}

export interface UnprovenContentDialogDeps {
  /** `container` に、証明の版 (左) と元のコード (右) の差分を読み取り専用で出す */
  createDiffView: (container: HTMLElement, divergence: RestoreDivergence) => DiffView;
  /** Blob をファイルとして保存させる */
  download: (blob: Blob, filename: string) => void;
}

/** ダウンロードする元のコードのファイル名の接頭辞 (通常の export・救出と取り違えない) */
export const UNPROVEN_DOWNLOAD_PREFIX = 'UNPROVEN_';

/**
 * 通知を出す。閉じると resolve する (差分の表示も片付ける)。
 * `divergences` が空なら何も出さずに resolve する。
 */
export async function showUnprovenContentDialog(
  divergences: readonly RestoreDivergence[],
  deps: UnprovenContentDialogDeps
): Promise<void> {
  if (divergences.length === 0) return;

  // ダウンロード名は通常の export と同じ規則 (同名タブの番号付けまで含めて)
  const nameOf = createExportNamer();
  const items = divergences.map((divergence) => ({
    divergence,
    downloadName: `${UNPROVEN_DOWNLOAD_PREFIX}${nameOf({ filename: divergence.filename, language: divergence.language }).source}`,
  }));

  const listHtml = items
    .map(({ divergence }) => {
      const summary = t('unprovenContent.tabSummary', {
        filename: divergence.filename,
        original: divergence.original.length,
        chain: divergence.chainContent.length,
      });
      return `
        <li class="unproven-item" data-tab-id="${escapeHtml(divergence.tabId)}"
            data-original-length="${divergence.original.length}"
            data-chain-length="${divergence.chainContent.length}">
          <span class="unproven-summary">${escapeHtml(summary)}</span>
          <span class="unproven-actions">
            <button type="button" class="modal-btn modal-btn-cancel" data-action="show-diff">
              <i class="fas fa-code-compare" aria-hidden="true"></i> ${t('unprovenContent.showDiff')}
            </button>
            <button type="button" class="modal-btn modal-btn-cancel" data-action="download">
              <i class="fas fa-download" aria-hidden="true"></i> ${t('unprovenContent.download')}
            </button>
          </span>
        </li>
      `;
    })
    .join('');

  const closed = showModal({
    title: t('unprovenContent.title'),
    icon: 'fa-exclamation-triangle',
    variant: 'info',
    className: 'unproven-content-dialog',
    dialogName: 'unproven-content',
    // 読んで閉じる知らせなので Escape では閉じてよい。差分を見る前の誤クリックで消えないよう overlay では閉じない
    closeOnOverlayClick: false,
    closeOnEscape: true,
    content: `
      <p class="unproven-message">${t('unprovenContent.message')}</p>
      <ul class="unproven-list">${listHtml}</ul>
      <p class="unproven-diff-label hidden">${t('unprovenContent.diffLabel')}</p>
      <div class="unproven-diff hidden" data-diff-tab-id=""></div>
      <p class="unproven-note">${t('unprovenContent.note')}</p>
    `,
    buttons: [{ text: t('unprovenContent.close'), type: 'primary' }],
  });

  // showModal は overlay を同期で DOM に足す。最後に足された同名の overlay がこの呼び出しのもの
  const overlays = document.querySelectorAll<HTMLElement>('[data-dialog="unproven-content"]');
  const overlay = overlays[overlays.length - 1];
  // コールバックの中で差し替えるので、制御フローの絞り込みを受けない入れ物に置く
  const current: { diffView: DiffView | null } = { diffView: null };

  if (overlay) {
    const diffContainer = overlay.querySelector<HTMLElement>('.unproven-diff')!;
    const diffLabel = overlay.querySelector<HTMLElement>('.unproven-diff-label')!;
    const rows = overlay.querySelectorAll<HTMLElement>('.unproven-item');

    rows.forEach((row, i) => {
      const item = items[i];
      if (!item) return;

      row.querySelector<HTMLButtonElement>('[data-action="show-diff"]')?.addEventListener('click', () => {
        current.diffView?.dispose();
        current.diffView = null;
        diffContainer.replaceChildren();
        diffContainer.classList.remove('hidden');
        diffLabel.classList.remove('hidden');
        diffContainer.dataset.diffTabId = item.divergence.tabId;
        try {
          current.diffView = deps.createDiffView(diffContainer, item.divergence);
        } catch (e) {
          console.error('[UnprovenContent] Could not show the diff:', e);
        }
      });

      row.querySelector<HTMLButtonElement>('[data-action="download"]')?.addEventListener('click', () => {
        try {
          deps.download(new Blob([item.divergence.original], { type: 'text/plain' }), item.downloadName);
        } catch (e) {
          console.error('[UnprovenContent] Could not download the original code:', e);
        }
      });
    });
  }

  await closed;
  current.diffView?.dispose();
}
