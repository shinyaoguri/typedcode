/**
 * SessionRecoveryDialog - セッション復旧ダイアログ
 *
 * ブラウザタブを閉じた後に再度開いた場合、前回のセッションから
 * 再開するか、新しいセッションを開始するかを選択させるダイアログ
 */

import { t } from '../../i18n/index.js';
import { escapeHtml, type SessionSummary, type TabSummary } from '@typedcode/shared';

export type SessionRecoveryChoice = 'resume' | 'fresh';

export interface SessionRecoveryDialogResult {
  choice: SessionRecoveryChoice;
}

/**
 * 日時をフォーマット
 */
function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  // 相対時間の表示
  let relativeTime: string;
  if (diffMinutes < 1) {
    relativeTime = 'just now';
  } else if (diffMinutes < 60) {
    relativeTime = `${diffMinutes} minutes ago`;
  } else if (diffHours < 24) {
    relativeTime = `${diffHours} hours ago`;
  } else {
    relativeTime = `${diffDays} days ago`;
  }

  // 絶対時間
  const dateStr = date.toLocaleDateString();
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return `${dateStr} ${timeStr} (${relativeTime})`;
}

/**
 * タブリストのHTMLを生成
 */
function generateTabListHtml(tabs: TabSummary[]): string {
  if (tabs.length === 0) {
    return '<li class="session-tab-empty">No files</li>';
  }

  return tabs
    .map((tab) => {
      const eventCountText = t('sessionRecovery.eventCount').replace('${count}', String(tab.eventCount));
      return `
        <li class="session-tab-item">
          <i class="fas fa-file-code"></i>
          <span class="session-tab-name">${escapeHtml(tab.filename)}</span>
          <span class="session-tab-events">${eventCountText}</span>
        </li>
      `;
    })
    .join('');
}

/**
 * セッション復旧ダイアログを表示
 *
 * @param sessionSummary セッションサマリー
 * @returns ユーザーの選択結果
 */
export function showSessionRecoveryDialog(
  sessionSummary: SessionSummary
): Promise<SessionRecoveryDialogResult> {
  return new Promise((resolve) => {
    // 既存のダイアログがあれば削除
    const existing = document.getElementById('session-recovery-overlay');
    existing?.remove();

    const lastActiveStr = formatDateTime(sessionSummary.lastActiveAt);
    const tabListHtml = generateTabListHtml(sessionSummary.tabs);
    const totalEvents = sessionSummary.tabs.reduce((sum, tab) => sum + tab.eventCount, 0);

    // オーバーレイ作成
    const overlay = document.createElement('div');
    overlay.id = 'session-recovery-overlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-dialog modal-info session-recovery-dialog">
        <div class="modal-header">
          <i class="fas fa-history"></i>
          <h3>${t('sessionRecovery.title')}</h3>
        </div>
        <div class="modal-body">
          <p class="session-recovery-message">${t('sessionRecovery.message')}</p>

          <div class="session-recovery-details">
            <div class="session-info-row">
              <span class="session-info-label">${t('sessionRecovery.lastActive')}:</span>
              <span class="session-info-value">${lastActiveStr}</span>
            </div>

            <div class="session-tabs-section">
              <span class="session-info-label">${t('sessionRecovery.tabs')}:</span>
              <ul class="session-tab-list">
                ${tabListHtml}
              </ul>
            </div>

            <div class="session-total-events">
              <i class="fas fa-list"></i>
              <span>${t('sessionRecovery.eventCount').replace('${count}', String(totalEvents))}</span>
            </div>
          </div>

          <div class="session-recovery-warning">
            <i class="fas fa-exclamation-triangle"></i>
            <span>${t('sessionRecovery.warning')}</span>
          </div>
        </div>
        <div class="modal-footer">
          <button id="session-fresh-btn" class="modal-btn modal-btn-danger">
            <i class="fas fa-trash"></i>
            ${t('sessionRecovery.startFresh')}
          </button>
          <button id="session-resume-btn" class="modal-btn modal-btn-primary">
            <i class="fas fa-play"></i>
            ${t('sessionRecovery.resume')}
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const resumeBtn = document.getElementById('session-resume-btn');
    const freshBtn = document.getElementById('session-fresh-btn');

    // 再開ボタン
    resumeBtn?.addEventListener('click', () => {
      disableButtons();
      updateButtonText('resume');
      cleanup();
      resolve({ choice: 'resume' });
    });

    // 新規セッションボタン
    freshBtn?.addEventListener('click', () => {
      disableButtons();
      updateButtonText('fresh');
      cleanup();
      resolve({ choice: 'fresh' });
    });

    function disableButtons(): void {
      if (resumeBtn) resumeBtn.setAttribute('disabled', 'true');
      if (freshBtn) freshBtn.setAttribute('disabled', 'true');
    }

    function updateButtonText(choice: 'resume' | 'fresh'): void {
      if (choice === 'resume' && resumeBtn) {
        resumeBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${t('sessionRecovery.resuming')}`;
      } else if (choice === 'fresh' && freshBtn) {
        freshBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${t('sessionRecovery.clearing')}`;
      }
    }

    function cleanup(): void {
      setTimeout(() => {
        overlay.classList.add('hidden');
        setTimeout(() => overlay.remove(), 200);
      }, 500);
    }
  });
}

/**
 * セッション復旧ダイアログを非表示
 */
export function hideSessionRecoveryDialog(): void {
  const overlay = document.getElementById('session-recovery-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
    setTimeout(() => overlay.remove(), 200);
  }
}
