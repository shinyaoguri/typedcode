/**
 * ScreenCaptureDialogs - 画面共有関連ダイアログ
 * 画面キャプチャの許可要求、エラー表示、ロックオーバーレイを担当
 */

import type { ScreenshotTracker } from '../../tracking/ScreenshotTracker.js';
import { t } from '../../i18n/index.js';

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

    // その他のエラー
    console.error('[TypedCode] Screen capture error:', result.error);
    return false;
  }

  console.error('[TypedCode] Max screen capture attempts reached');
  return false;
}

/**
 * 画面全体の選択が必要であることを示すダイアログを表示
 */
export async function showMonitorRequiredDialog(selectedType: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.getElementById('monitor-required-dialog');
    const retryBtn = document.getElementById('monitor-required-retry-btn');
    const cancelBtn = document.getElementById('monitor-required-cancel-btn');
    const selectedTypeEl = document.getElementById('monitor-selected-type');

    if (!dialog || !retryBtn || !cancelBtn) {
      // ダイアログが存在しない場合はalertで代用
      const retry = confirm(
        `「${selectedType}」が選択されました。\n\nTypedCodeでは画面全体の共有が必要です。\n「画面全体」または「モニター」を選択してください。\n\n再試行しますか？`
      );
      resolve(retry);
      return;
    }

    if (selectedTypeEl) {
      selectedTypeEl.textContent = selectedType;
    }

    dialog.classList.remove('hidden');

    const handleRetry = (): void => {
      cleanup();
      dialog.classList.add('hidden');
      resolve(true);
    };

    const handleCancel = (): void => {
      cleanup();
      dialog.classList.add('hidden');
      resolve(false);
    };

    const cleanup = (): void => {
      retryBtn.removeEventListener('click', handleRetry);
      cancelBtn.removeEventListener('click', handleCancel);
    };

    retryBtn.addEventListener('click', handleRetry);
    cancelBtn.addEventListener('click', handleCancel);
  });
}

/**
 * 画面共有が必要であることを示すダイアログを表示
 */
export async function showScreenCaptureRequiredDialog(): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.getElementById('screen-capture-required-dialog');
    const retryBtn = document.getElementById('screen-capture-retry-btn');
    const cancelBtn = document.getElementById('screen-capture-cancel-btn');

    if (!dialog || !retryBtn || !cancelBtn) {
      // ダイアログが存在しない場合はalertで代用
      const retry = confirm(
        'TypedCodeを使用するには画面共有の許可が必要です。\n\n再試行しますか？'
      );
      resolve(retry);
      return;
    }

    dialog.classList.remove('hidden');

    const handleRetry = (): void => {
      cleanup();
      dialog.classList.add('hidden');
      resolve(true);
    };

    const handleCancel = (): void => {
      cleanup();
      dialog.classList.add('hidden');
      resolve(false);
    };

    const cleanup = (): void => {
      retryBtn.removeEventListener('click', handleRetry);
      cancelBtn.removeEventListener('click', handleCancel);
    };

    retryBtn.addEventListener('click', handleRetry);
    cancelBtn.addEventListener('click', handleCancel);
  });
}

/**
 * 画面共有停止時のロックオーバーレイを表示
 */
export function showScreenCaptureLockOverlay(
  onResume: () => Promise<boolean>
): void {
  let overlay = document.getElementById('screen-capture-lock-overlay');

  if (!overlay) {
    // オーバーレイが存在しない場合は動的に作成
    overlay = document.createElement('div');
    overlay.id = 'screen-capture-lock-overlay';
    overlay.className = 'screen-capture-lock-overlay';
    overlay.innerHTML = `
      <div class="screen-capture-lock-content">
        <i class="fas fa-desktop fa-3x"></i>
        <h2>${t('screenCapture.lockTitle') ?? '画面共有が停止されました'}</h2>
        <p>${t('screenCapture.lockDescription') ?? 'TypedCodeを使用するには画面全体の共有が必要です。'}</p>
        <button id="screen-capture-resume-btn" class="btn btn-primary">
          <i class="fas fa-play"></i>
          ${t('screenCapture.resumeButton') ?? '画面共有を再開'}
        </button>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  overlay.classList.remove('hidden');

  // 再開ボタンのイベントリスナー
  const resumeBtn = document.getElementById('screen-capture-resume-btn');
  resumeBtn?.addEventListener('click', async () => {
    const result = await onResume();
    if (result) {
      hideScreenCaptureLockOverlay();
    }
  });
}

/**
 * 画面共有ロックオーバーレイを非表示
 */
export function hideScreenCaptureLockOverlay(): void {
  const overlay = document.getElementById('screen-capture-lock-overlay');
  overlay?.classList.add('hidden');
}
