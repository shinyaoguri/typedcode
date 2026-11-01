/**
 * About Dialog Component
 *
 * Shows version information and project details.
 */

import {
  getBuildInfo,
  PROOF_FORMAT_VERSION,
  STORAGE_FORMAT_VERSION,
  GITHUB_URL,
  AUTHOR_GITHUB,
} from '@typedcode/shared';
import type { I18nInstance } from '@typedcode/shared';
import { attachDialogA11y } from './dialogA11y.js';

/**
 * Format ISO date string to locale date string
 */
function formatDate(isoDate: string, locale: string): string {
  if (!isoDate) return '-';
  try {
    const date = new Date(isoDate);
    return date.toLocaleDateString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoDate;
  }
}

export interface AboutDialogOptions {
  /** 閉じた後に戻すフォーカス先。About は設定メニューの項目から開くが、メニューは開くと同時に閉じるので、メニューを開いたボタンを渡す */
  returnFocusTo?: HTMLElement | null;
}

/**
 * Show the about dialog
 *
 * a11y (#305) は `dialogA11y.ts` が担う。どの経路で閉じても `closeModal` を通り、
 * document の keydown リスナーはそこで解放される。
 */
export function showAboutDialog(i18n: I18nInstance, options: AboutDialogOptions = {}): void {
  const buildInfo = getBuildInfo();
  const locale = i18n.getLocale();

  // Create overlay
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  // Create dialog
  const dialog = document.createElement('div');
  dialog.className = 'modal-dialog modal-about';

  dialog.innerHTML = `
    <button class="modal-close-btn" aria-label="${i18n.t('common.close')}">
      <i class="fas fa-times" aria-hidden="true"></i>
    </button>
    <div class="about-dialog-content">
      <div class="about-header">
        <img src="/icon-192.png" alt="TypedCode" class="about-logo">
        <div class="about-title-section">
          <h2 class="about-app-name">TypedCode</h2>
          <p class="about-version">v${buildInfo.appVersion}</p>
        </div>
      </div>

      <div class="about-author">
        <a href="https://github.com/${AUTHOR_GITHUB}" target="_blank" rel="noopener noreferrer">
          <i class="fab fa-github"></i> @${AUTHOR_GITHUB}
        </a>
      </div>

      <div class="about-info-grid">
        <div class="about-info-row">
          <span class="about-info-label">${i18n.t('about.appVersion')}</span>
          <span class="about-info-value">${buildInfo.appVersion}</span>
        </div>
        <div class="about-info-row">
          <span class="about-info-label">${i18n.t('about.proofVersion')}</span>
          <span class="about-info-value">${PROOF_FORMAT_VERSION}</span>
        </div>
        <div class="about-info-row">
          <span class="about-info-label">${i18n.t('about.storageVersion')}</span>
          <span class="about-info-value">${STORAGE_FORMAT_VERSION}</span>
        </div>
        <div class="about-info-row">
          <span class="about-info-label">${i18n.t('about.commit')}</span>
          <span class="about-info-value">
            <a href="${GITHUB_URL}/commit/${buildInfo.gitCommit}" target="_blank" rel="noopener noreferrer">
              ${buildInfo.gitCommit}
            </a>
          </span>
        </div>
        <div class="about-info-row">
          <span class="about-info-label">${i18n.t('about.lastUpdate')}</span>
          <span class="about-info-value">${formatDate(buildInfo.gitCommitDate, locale)}</span>
        </div>
        <div class="about-info-row">
          <span class="about-info-label">${i18n.t('about.buildDate')}</span>
          <span class="about-info-value">${formatDate(buildInfo.buildDate, locale)}</span>
        </div>
      </div>

      <div class="about-links">
        <a href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer" class="about-github-link">
          <i class="fab fa-github"></i> ${i18n.t('about.viewOnGithub')}
        </a>
      </div>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const closeBtn = dialog.querySelector<HTMLElement>('.modal-close-btn');

  const a11y = attachDialogA11y(dialog, {
    labelledBy: dialog.querySelector<HTMLElement>('.about-app-name')!,
    initialFocus: closeBtn,
    returnFocusTo: options.returnFocusTo,
    onRequestClose: () => closeModal(),
  });

  // Close handlers (冪等: どの経路から何度呼ばれても片付けは 1 回)
  let closed = false;
  const closeModal = (): void => {
    if (closed) return;
    closed = true;
    a11y.close();
    overlay.classList.add('hidden');
    setTimeout(() => overlay.remove(), 200);
  };

  // Close button
  closeBtn?.addEventListener('click', closeModal);

  // Click outside to close
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      closeModal();
    }
  });
}
