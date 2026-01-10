/**
 * ScreenCaptureDialogs - 画面共有関連ダイアログ
 * 画面キャプチャの許可要求、エラー表示、ロックオーバーレイを担当
 */

import type { ScreenshotTracker } from '../../tracking/ScreenshotTracker.js';
import { showScreenShareErrorDialog } from '../components/ScreenShareErrorDialog.js';
import { showLockOverlay, hideLockOverlay } from '../components/Modal.js';
import { t } from '../../i18n/index.js';

const SCREEN_CAPTURE_LOCK_OVERLAY_ID = 'screen-capture-lock-overlay';
const SCREEN_SHARE_OPT_OUT_BANNER_ID = 'screen-share-opt-out-banner';

/** 画面共有選択の結果 */
export type ScreenShareChoice = 'share' | 'optOut' | 'cancelled';

/**
 * 画面共有の選択ダイアログを表示
 * 「画面共有を開始」または「画面共有なしで使用」を選択させる
 */
export async function showScreenShareChoiceDialog(): Promise<ScreenShareChoice> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'modal-dialog screen-share-choice-dialog';

    dialog.innerHTML = `
      <div class="modal-header">
        <i class="fas fa-desktop"></i>
        <h3>${t('screenCapture.choiceTitle') ?? 'Screen Sharing Settings'}</h3>
      </div>
      <div class="modal-body">
        <p class="choice-description">${t('screenCapture.choiceDescription') ?? 'TypedCode uses screen capture to enhance proof reliability.'}</p>
        <div class="choice-options">
          <button class="choice-option choice-option-primary" data-choice="share">
            <div class="choice-icon">
              <i class="fas fa-desktop"></i>
            </div>
            <div class="choice-content">
              <span class="choice-title">${t('screenCapture.startScreenShare') ?? 'Start Screen Sharing'}</span>
              <span class="choice-subtitle">${t('screenCapture.startScreenShareDesc') ?? 'Recommended: Ensures highest trust level'}</span>
            </div>
          </button>
          <button class="choice-option choice-option-secondary" data-choice="optOut">
            <div class="choice-icon">
              <i class="fas fa-eye-slash"></i>
            </div>
            <div class="choice-content">
              <span class="choice-title">${t('screenCapture.useWithoutScreenShare') ?? 'Use Without Screen Sharing'}</span>
              <span class="choice-subtitle">${t('screenCapture.useWithoutScreenShareDesc') ?? 'Warning: Proof trust level will be reduced'}</span>
            </div>
          </button>
        </div>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const closeDialog = (choice: ScreenShareChoice): void => {
      overlay.classList.add('hidden');
      setTimeout(() => {
        overlay.remove();
        resolve(choice);
      }, 200);
    };

    // イベントリスナーを設定
    const shareBtn = dialog.querySelector('[data-choice="share"]');
    const optOutBtn = dialog.querySelector('[data-choice="optOut"]');

    shareBtn?.addEventListener('click', () => closeDialog('share'));
    optOutBtn?.addEventListener('click', () => closeDialog('optOut'));

    // Escキーでキャンセル
    const handleEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', handleEscape);
        closeDialog('cancelled');
      }
    };
    document.addEventListener('keydown', handleEscape);
  });
}

/**
 * 画面共有オプトアウトの確認ダイアログを表示
 */
export async function showScreenShareOptOutConfirmDialog(): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'modal-dialog modal-default screen-share-optout-confirm-dialog';

    dialog.innerHTML = `
      <div class="modal-header">
        <i class="fas fa-exclamation-triangle"></i>
        <h3>${t('screenCapture.optOutConfirmTitle') ?? 'Continue Without Screen Sharing'}</h3>
      </div>
      <div class="modal-body">
        <p>${t('screenCapture.optOutConfirmDescription') ?? 'Using without screen sharing means:'}</p>
        <ul class="optout-warnings">
          <li><i class="fas fa-exclamation-circle"></i> ${t('screenCapture.optOutWarning1') ?? 'Proof trust level will be reduced'}</li>
          <li><i class="fas fa-link"></i> ${t('screenCapture.optOutWarning2') ?? 'The opt-out will be recorded in the hash chain'}</li>
          <li><i class="fas fa-check-circle"></i> ${t('screenCapture.optOutWarning3') ?? 'You can enable screen sharing later'}</li>
        </ul>
      </div>
      <div class="modal-footer">
        <button class="modal-btn modal-btn-cancel" data-action="cancel">${t('common.cancel') ?? 'Cancel'}</button>
        <button class="modal-btn modal-btn-primary" data-action="confirm">${t('screenCapture.optOutConfirm') ?? 'I Understand'}</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const closeDialog = (confirmed: boolean): void => {
      overlay.classList.add('hidden');
      setTimeout(() => {
        overlay.remove();
        resolve(confirmed);
      }, 200);
    };

    const cancelBtn = dialog.querySelector('[data-action="cancel"]');
    const confirmBtn = dialog.querySelector('[data-action="confirm"]');

    cancelBtn?.addEventListener('click', () => closeDialog(false));
    confirmBtn?.addEventListener('click', () => closeDialog(true));

    // Escキーでキャンセル
    const handleEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', handleEscape);
        closeDialog(false);
      }
    };
    document.addEventListener('keydown', handleEscape);
  });
}

/**
 * オプトアウトバナーを表示
 */
export function showScreenShareOptOutBanner(
  onEnableScreenShare: () => Promise<boolean>
): void {
  // 既存のバナーがあれば削除
  hideScreenShareOptOutBanner();

  const banner = document.createElement('div');
  banner.id = SCREEN_SHARE_OPT_OUT_BANNER_ID;
  banner.className = 'screen-share-opt-out-banner';

  banner.innerHTML = `
    <div class="banner-content">
      <i class="fas fa-exclamation-triangle"></i>
      <span class="banner-text">${t('screenCapture.optedOutBanner') ?? 'Running without screen sharing'}</span>
      <button class="banner-btn" type="button">
        <i class="fas fa-desktop"></i>
        ${t('screenCapture.enableScreenShare') ?? 'Enable Screen Sharing'}
      </button>
    </div>
  `;

  // ボタンのイベントリスナー
  const btn = banner.querySelector('.banner-btn');
  btn?.addEventListener('click', async () => {
    btn.setAttribute('disabled', 'true');
    const success = await onEnableScreenShare();
    if (success) {
      hideScreenShareOptOutBanner();
    } else {
      btn.removeAttribute('disabled');
    }
  });

  // #app の先頭に挿入（flexboxフローでヘッダーの上に表示）
  const appContainer = document.getElementById('app');
  if (appContainer) {
    appContainer.insertBefore(banner, appContainer.firstChild);
  } else {
    // フォールバック: bodyの先頭
    document.body.insertBefore(banner, document.body.firstChild);
  }
}

/**
 * オプトアウトバナーを非表示
 */
export function hideScreenShareOptOutBanner(): void {
  const banner = document.getElementById(SCREEN_SHARE_OPT_OUT_BANNER_ID);
  if (banner) {
    banner.remove();
  }
}

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
 * @param onResume 画面共有を再開するコールバック
 * @param onContinueWithout 画面共有なしで継続するコールバック（オプション）
 */
export function showScreenCaptureLockOverlay(
  onResume: () => Promise<boolean>,
  onContinueWithout?: () => Promise<boolean>
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
    secondaryButtonText: onContinueWithout
      ? (t('screenCapture.continueWithoutButton') ?? '画面共有なしで継続')
      : undefined,
    onSecondaryAction: onContinueWithout
      ? async () => {
          const result = await onContinueWithout();
          return result;
        }
      : undefined,
  });
}

/**
 * 画面共有ロックオーバーレイを非表示
 */
export function hideScreenCaptureLockOverlay(): void {
  hideLockOverlay(SCREEN_CAPTURE_LOCK_OVERLAY_ID);
}
