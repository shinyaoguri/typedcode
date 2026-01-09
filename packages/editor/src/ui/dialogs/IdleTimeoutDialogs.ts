/**
 * IdleTimeoutDialogs - アイドルタイムアウト関連ダイアログ
 */

import { t } from '../../i18n/index.js';
import { showCountdownDialog, showLockOverlay, hideLockOverlay } from '../components/Modal.js';

const IDLE_WARNING_OVERLAY_ID = 'idle-warning-overlay';
const IDLE_SUSPENDED_OVERLAY_ID = 'idle-suspended-overlay';

/**
 * 警告ダイアログを表示（カウントダウン付き）
 * @param timeoutMs タイムアウトまでの時間（ミリ秒）
 * @returns true: 継続ボタン押下、false: タイムアウト
 */
export function showIdleWarningDialog(timeoutMs: number): Promise<boolean> {
  return showCountdownDialog({
    title: t('idleTimeout.warningTitle') ?? 'Session Warning',
    message: t('idleTimeout.warningMessage') ?? 'Your session is about to expire due to inactivity.',
    seconds: Math.floor(timeoutMs / 1000),
    continueButtonText: t('idleTimeout.continueButton') ?? 'Continue',
    icon: 'fa-clock',
    dialogId: IDLE_WARNING_OVERLAY_ID,
    countdownLabel: t('idleTimeout.countdownLabel') ?? '',
  });
}

/**
 * 記録停止オーバーレイを表示
 * @param onResume 再開ボタン押下時のコールバック
 */
export function showIdleSuspendedOverlay(onResume: () => void): void {
  showLockOverlay({
    overlayId: IDLE_SUSPENDED_OVERLAY_ID,
    title: t('idleTimeout.suspendedTitle') ?? 'Recording Paused',
    description: t('idleTimeout.suspendedMessage') ?? 'Recording has been paused due to inactivity.',
    hint: t('idleTimeout.suspendedHint'),
    buttonText: t('idleTimeout.resumeButton') ?? 'Resume',
    icon: 'pause-circle',
    className: 'idle-suspended-overlay',
    onResume,
  });
}

/**
 * 記録停止オーバーレイを非表示
 */
export function hideIdleSuspendedOverlay(): void {
  hideLockOverlay(IDLE_SUSPENDED_OVERLAY_ID);
}
