/**
 * ScreenCaptureDialogs - 画面共有関連ダイアログ
 * 画面キャプチャの許可要求、エラー表示、ロックオーバーレイを担当
 */

import type { ScreenshotTracker } from '../../tracking/ScreenshotTracker.js';
import { showScreenShareErrorDialog } from '../components/ScreenShareErrorDialog.js';
import { showLockOverlay, hideLockOverlay } from '../components/Modal.js';
import { t } from '../../i18n/index.js';

const SCREEN_CAPTURE_LOCK_OVERLAY_ID = 'screen-capture-lock-overlay';

/**
 * 画面共有の許可を要求（画面全体が選択されるまで繰り返す）
 */
export async function requestScreenCaptureWithRetry(
  tracker: ScreenshotTracker,
  updateInitMessage?: (message: string) => void
): Promise<boolean> {
  const maxAttempts = 10; // 無限ループ防止

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    updateInitMessage?.(t('screenCapture.requesting') ?? 'Requesting screen capture permission...');
    console.log(`[TypedCode] Requesting screen capture permission (attempt ${attempt})...`);

    const result = await tracker.requestPermissionAndAttach(true); // requireMonitor = true

    console.log('[TypedCode] Screen capture result:', result);

    if (result.success) {
      return true;
    }

    if (result.error === 'monitor_required') {
      // タブやウィンドウが選択された場合、ユーザーに画面全体を選択するよう促す
      const surfaceName = result.displaySurface === 'window' ? 'ウィンドウ' : 'タブ';
      const shouldRetry = await showMonitorRequiredDialog(surfaceName);
      if (!shouldRetry) {
        console.log('[TypedCode] User cancelled screen capture');
        return false;
      }
      // ループを続行して再度許可を求める
      continue;
    }

    if (result.error === 'User denied screen capture permission') {
      // ユーザーがキャンセルした場合
      const shouldRetry = await showScreenCaptureRequiredDialog();
      if (!shouldRetry) {
        return false;
      }
      continue;
    }

    // その他のエラー（storage_init_failed、NotSupportedError など）
    console.error('[TypedCode] Screen capture error:', result.error);
    const shouldRetry = await showScreenShareErrorDialog(result.error, undefined, { showRetry: true });
    if (!shouldRetry) {
      return false;
    }
    continue;
  }

  console.error('[TypedCode] Max screen capture attempts reached');
  return false;
}

/**
 * 画面全体の選択が必要であることを示すダイアログを表示
 */
export async function showMonitorRequiredDialog(_selectedType: string): Promise<boolean> {
  // 新しいエラーダイアログを使用（再試行ボタン付き）
  return showScreenShareErrorDialog('monitor_required', undefined, { showRetry: true });
}

/**
 * 画面共有が必要であることを示すダイアログを表示
 */
export async function showScreenCaptureRequiredDialog(): Promise<boolean> {
  // 新しいエラーダイアログを使用（再試行ボタン付き）
  return showScreenShareErrorDialog('NotAllowedError', undefined, { showRetry: true });
}

/**
 * 画面共有停止時のロックオーバーレイを表示
 */
export function showScreenCaptureLockOverlay(
  onResume: () => Promise<boolean>
): void {
  showLockOverlay({
    overlayId: SCREEN_CAPTURE_LOCK_OVERLAY_ID,
    title: t('screenCapture.lockTitle') ?? '画面共有が停止されました',
    description: t('screenCapture.lockDescription') ?? 'TypedCodeを使用するには画面全体の共有が必要です。',
    buttonText: t('screenCapture.resumeButton') ?? '画面共有を再開',
    icon: 'desktop',
    className: 'screen-capture-lock-overlay',
    onResume: async () => {
      const result = await onResume();
      return result; // false を返すとオーバーレイが閉じない
    },
  });
}

/**
 * 画面共有ロックオーバーレイを非表示
 */
export function hideScreenCaptureLockOverlay(): void {
  hideLockOverlay(SCREEN_CAPTURE_LOCK_OVERLAY_ID);
}
