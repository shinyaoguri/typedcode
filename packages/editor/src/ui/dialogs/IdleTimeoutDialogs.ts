/**
 * IdleTimeoutDialogs - アイドルタイムアウト関連ダイアログ
 */

import { t } from '../../i18n/index.js';

/**
 * 警告ダイアログを表示（カウントダウン付き）
 * @param timeoutMs タイムアウトまでの時間（ミリ秒）
 * @returns true: 継続ボタン押下、false: タイムアウト
 */
export function showIdleWarningDialog(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    // 既存のダイアログがあれば削除
    const existing = document.getElementById('idle-warning-overlay');
    existing?.remove();

    const timeoutSec = Math.floor(timeoutMs / 1000);
    let remainingSeconds = timeoutSec;
    let countdownInterval: ReturnType<typeof setInterval> | null = null;

    // オーバーレイ作成
    const overlay = document.createElement('div');
    overlay.id = 'idle-warning-overlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-dialog modal-info idle-warning-dialog">
        <div class="modal-header">
          <i class="fas fa-clock"></i>
          <h3>${t('idleTimeout.warningTitle')}</h3>
        </div>
        <div class="modal-body">
          <p>${t('idleTimeout.warningMessage')}</p>
          <div class="idle-countdown">
            <span class="idle-countdown-time" id="idle-countdown-display">${formatTime(remainingSeconds)}</span>
            <span class="idle-countdown-label">${t('idleTimeout.countdownLabel')}</span>
          </div>
        </div>
        <div class="modal-footer">
          <button id="idle-continue-btn" class="modal-btn modal-btn-primary">
            <i class="fas fa-play"></i>
            ${t('idleTimeout.continueButton')}
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const countdownDisplay = document.getElementById('idle-countdown-display');
    const continueBtn = document.getElementById('idle-continue-btn');

    // カウントダウン開始
    countdownInterval = setInterval(() => {
      remainingSeconds--;
      if (countdownDisplay) {
        countdownDisplay.textContent = formatTime(remainingSeconds);
      }

      if (remainingSeconds <= 0) {
        cleanup();
        resolve(false); // タイムアウト
      }
    }, 1000);

    // 継続ボタン
    continueBtn?.addEventListener('click', () => {
      cleanup();
      resolve(true);
    });

    function cleanup(): void {
      if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
      overlay.classList.add('hidden');
      setTimeout(() => overlay.remove(), 200);
    }

    function formatTime(seconds: number): string {
      const min = Math.floor(seconds / 60);
      const sec = seconds % 60;
      return `${min}:${sec.toString().padStart(2, '0')}`;
    }
  });
}

/**
 * 記録停止オーバーレイを表示
 * @param onResume 再開ボタン押下時のコールバック
 */
export function showIdleSuspendedOverlay(onResume: () => void): void {
  // 既存のオーバーレイがあれば削除
  hideIdleSuspendedOverlay();

  const overlay = document.createElement('div');
  overlay.id = 'idle-suspended-overlay';
  overlay.className = 'idle-suspended-overlay';
  overlay.innerHTML = `
    <div class="idle-suspended-content">
      <i class="fas fa-pause-circle fa-4x"></i>
      <h2>${t('idleTimeout.suspendedTitle')}</h2>
      <p>${t('idleTimeout.suspendedMessage')}</p>
      <p class="idle-suspended-hint">${t('idleTimeout.suspendedHint')}</p>
      <button id="idle-resume-btn" class="btn btn-primary">
        <i class="fas fa-play"></i>
        ${t('idleTimeout.resumeButton')}
      </button>
    </div>
  `;

  document.body.appendChild(overlay);

  const resumeBtn = document.getElementById('idle-resume-btn');
  resumeBtn?.addEventListener('click', () => {
    onResume();
  });
}

/**
 * 記録停止オーバーレイを非表示
 */
export function hideIdleSuspendedOverlay(): void {
  const overlay = document.getElementById('idle-suspended-overlay');
  overlay?.remove();
}
