/**
 * About Dialog for Verify App
 *
 * Shows version information and project details.
 */

import {
  getBuildInfo,
  PROOF_FORMAT_VERSION,
  STORAGE_FORMAT_VERSION,
  GITHUB_URL,
  AUTHOR_GITHUB,
  type I18nInstance,
} from '@typedcode/shared';

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

/**
 * Show the about dialog
 */
export function showAboutDialog(i18n: I18nInstance): void {
  const buildInfo = getBuildInfo();
  const locale = i18n.getLocale();

  // Create overlay
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay visible';

  // Create dialog
  const dialog = document.createElement('div');
  dialog.className = 'modal-dialog modal-about';

  dialog.innerHTML = `
    <button class="modal-close-btn" aria-label="${i18n.t('common.close')}">
      <i class="fas fa-times"></i>
    </button>
    <div class="about-dialog-content">
      <div class="about-header">
        <img src="/icon-192.png" alt="TypedCode Verify" class="about-logo">
        <div class="about-title-section">
          <h2 class="about-app-name">TypedCode Verify</h2>
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

  // Close handlers
  const closeModal = (): void => {
    overlay.classList.remove('visible');
    setTimeout(() => overlay.remove(), 200);
  };

  // Close button
  const closeBtn = dialog.querySelector('.modal-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', closeModal);
  }

  // Click outside to close
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      closeModal();
    }
  });

  // Escape key to close
  const handleEscape = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      closeModal();
      document.removeEventListener('keydown', handleEscape);
    }
  };
  document.addEventListener('keydown', handleEscape);
}
