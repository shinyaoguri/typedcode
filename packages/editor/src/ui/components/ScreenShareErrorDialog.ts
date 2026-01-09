/**
 * ScreenShareErrorDialog - 画面共有エラー時のダイアログ表示
 *
 * 画面共有が失敗した際に、原因と対策をユーザーに提示するダイアログを表示する
 */

import { showModal } from './Modal.js';
import { t } from '../../i18n/index.js';
import { escapeHtml } from '@typedcode/shared';

/** 画面共有エラーの種類 */
export type ScreenShareErrorType =
  | 'NotAllowedError'
  | 'NotSupportedError'
  | 'NotReadableError'
  | 'OverconstrainedError'
  | 'AbortError'
  | 'SecurityError'
  | 'OutOfMemoryError'
  | 'monitor_required'
  | 'storage_init_failed'
  | 'unknown';

/** エラータイプに応じた情報 */
interface ErrorInfo {
  titleKey: keyof typeof screenCaptureKeys;
  descKey: keyof typeof screenCaptureKeys;
  solutionKeys: (keyof typeof screenCaptureKeys)[];
  icon: string;
}

// 型推論のためのヘルパー
const screenCaptureKeys = {
  errorNotAllowed: '',
  errorNotAllowedDesc: '',
  errorNotSupported: '',
  errorNotSupportedDesc: '',
  errorNotReadable: '',
  errorNotReadableDesc: '',
  errorOverconstrained: '',
  errorOverconstrainedDesc: '',
  errorAborted: '',
  errorAbortedDesc: '',
  errorSecurityError: '',
  errorSecurityErrorDesc: '',
  errorOutOfMemory: '',
  errorOutOfMemoryDesc: '',
  errorMonitorRequired: '',
  errorMonitorRequiredDesc: '',
  errorStorageInitFailed: '',
  errorStorageInitFailedDesc: '',
  errorUnknown: '',
  solutionRefresh: '',
  solutionCloseOtherTabs: '',
  solutionCheckPermissions: '',
  solutionUseChrome: '',
  solutionSelectMonitor: '',
  solutionClearBrowserData: '',
  solutionRestartBrowser: '',
  solutionCheckHttps: '',
  solutionFreeMemory: '',
};

/** エラータイプごとの設定 */
const ERROR_INFO_MAP: Record<ScreenShareErrorType, ErrorInfo> = {
  NotAllowedError: {
    titleKey: 'errorNotAllowed',
    descKey: 'errorNotAllowedDesc',
    solutionKeys: ['solutionCheckPermissions', 'solutionRefresh'],
    icon: 'fa-ban',
  },
  NotSupportedError: {
    titleKey: 'errorNotSupported',
    descKey: 'errorNotSupportedDesc',
    solutionKeys: ['solutionUseChrome'],
    icon: 'fa-browser',
  },
  NotReadableError: {
    titleKey: 'errorNotReadable',
    descKey: 'errorNotReadableDesc',
    solutionKeys: ['solutionRestartBrowser', 'solutionRefresh'],
    icon: 'fa-desktop',
  },
  OverconstrainedError: {
    titleKey: 'errorOverconstrained',
    descKey: 'errorOverconstrainedDesc',
    solutionKeys: ['solutionRefresh', 'solutionRestartBrowser'],
    icon: 'fa-sliders-h',
  },
  AbortError: {
    titleKey: 'errorAborted',
    descKey: 'errorAbortedDesc',
    solutionKeys: ['solutionRefresh', 'solutionRestartBrowser'],
    icon: 'fa-times-circle',
  },
  SecurityError: {
    titleKey: 'errorSecurityError',
    descKey: 'errorSecurityErrorDesc',
    solutionKeys: ['solutionCheckHttps', 'solutionCheckPermissions'],
    icon: 'fa-shield-alt',
  },
  OutOfMemoryError: {
    titleKey: 'errorOutOfMemory',
    descKey: 'errorOutOfMemoryDesc',
    solutionKeys: ['solutionCloseOtherTabs', 'solutionFreeMemory', 'solutionRestartBrowser'],
    icon: 'fa-memory',
  },
  monitor_required: {
    titleKey: 'errorMonitorRequired',
    descKey: 'errorMonitorRequiredDesc',
    solutionKeys: ['solutionSelectMonitor'],
    icon: 'fa-tv',
  },
  storage_init_failed: {
    titleKey: 'errorStorageInitFailed',
    descKey: 'errorStorageInitFailedDesc',
    solutionKeys: ['solutionClearBrowserData', 'solutionRefresh'],
    icon: 'fa-database',
  },
  unknown: {
    titleKey: 'errorNotReadable',
    descKey: 'errorNotReadableDesc',
    solutionKeys: ['solutionRefresh', 'solutionRestartBrowser'],
    icon: 'fa-exclamation-triangle',
  },
};

/**
 * エラーメッセージからエラータイプを推測
 */
export function detectErrorType(error: string | Error | undefined): ScreenShareErrorType {
  if (!error) return 'unknown';

  const errorString = typeof error === 'string' ? error : error.name || error.message || '';
  const errorMessage = typeof error === 'string' ? error : error.message || '';

  // Error.name によるマッチング
  if (errorString === 'NotAllowedError' || errorString.includes('NotAllowedError')) {
    return 'NotAllowedError';
  }
  if (errorString === 'NotSupportedError' || errorString.includes('NotSupportedError')) {
    return 'NotSupportedError';
  }
  if (errorString === 'NotReadableError' || errorString.includes('NotReadableError')) {
    return 'NotReadableError';
  }
  if (errorString === 'OverconstrainedError' || errorString.includes('OverconstrainedError')) {
    return 'OverconstrainedError';
  }
  if (errorString === 'AbortError' || errorString.includes('AbortError')) {
    return 'AbortError';
  }
  if (errorString === 'SecurityError' || errorString.includes('SecurityError')) {
    return 'SecurityError';
  }

  // 特殊なエラータイプ
  if (errorString === 'monitor_required') {
    return 'monitor_required';
  }
  if (errorString === 'storage_init_failed') {
    return 'storage_init_failed';
  }

  // メッセージ内容によるマッチング
  const lowerMessage = errorMessage.toLowerCase();
  if (lowerMessage.includes('out of memory') || lowerMessage.includes('memory')) {
    return 'OutOfMemoryError';
  }
  if (lowerMessage.includes('permission') || lowerMessage.includes('denied')) {
    return 'NotAllowedError';
  }
  if (lowerMessage.includes('not supported')) {
    return 'NotSupportedError';
  }
  if (lowerMessage.includes('security')) {
    return 'SecurityError';
  }

  return 'unknown';
}

/** エラーダイアログのオプション */
interface ScreenShareErrorDialogOptions {
  /** 再試行ボタンを表示するか */
  showRetry?: boolean;
}

/**
 * 画面共有エラーダイアログを表示
 *
 * @param errorType - エラータイプ（指定しない場合は'unknown'）
 * @param rawError - 元のエラー文字列（デバッグ用に表示）
 * @param options - ダイアログオプション
 * @returns Promise<boolean> - 再試行ボタンが押された場合はtrue、それ以外はfalse
 */
export async function showScreenShareErrorDialog(
  errorType?: ScreenShareErrorType | string | Error,
  rawError?: string,
  options?: ScreenShareErrorDialogOptions
): Promise<boolean> {
  const { showRetry = false } = options ?? {};

  // エラータイプを判定
  let resolvedErrorType: ScreenShareErrorType;
  if (typeof errorType === 'string' && errorType in ERROR_INFO_MAP) {
    resolvedErrorType = errorType as ScreenShareErrorType;
  } else {
    resolvedErrorType = detectErrorType(errorType);
  }

  const errorInfo = ERROR_INFO_MAP[resolvedErrorType];

  // 翻訳を取得
  const title = t(`screenCapture.${errorInfo.titleKey}`) ?? 'Screen Share Error';
  const description = t(`screenCapture.${errorInfo.descKey}`) ?? 'An error occurred.';
  const solutionTitle = t('screenCapture.solutionTitle') ?? 'Solutions';

  // 解決策リストを生成
  const solutions = errorInfo.solutionKeys
    .map((key) => t(`screenCapture.${key}`))
    .filter((s): s is string => !!s);

  // HTMLコンテンツを構築
  let content = `
    <div class="screen-share-error-dialog">
      <p class="error-description">${description}</p>

      <div class="solutions-section">
        <h4>${solutionTitle}</h4>
        <ul class="solutions-list">
          ${solutions.map((s) => `<li><i class="fas fa-check"></i> ${s}</li>`).join('')}
        </ul>
      </div>
  `;

  // デバッグ情報（開発者向け）
  if (rawError) {
    content += `
      <details class="error-details">
        <summary>Technical details</summary>
        <code>${escapeHtml(rawError)}</code>
      </details>
    `;
  }

  content += '</div>';

  // 再試行フラグ
  let shouldRetry = false;

  // ボタンを構築
  const buttons = [];

  if (showRetry) {
    buttons.push({
      text: t('common.cancel') ?? 'Cancel',
      type: 'cancel' as const,
    });
    buttons.push({
      text: t('common.retry') ?? 'Retry',
      type: 'primary' as const,
      icon: 'fa-redo',
      onClick: () => {
        shouldRetry = true;
        return true;
      },
    });
  } else {
    buttons.push({
      text: t('common.close') ?? 'Close',
      type: 'primary' as const,
    });
  }

  // モーダルを表示
  await showModal({
    title,
    content,
    variant: 'danger',
    icon: errorInfo.icon,
    closeOnOverlayClick: !showRetry, // 再試行モードでは外側クリックで閉じない
    className: 'screen-share-error-modal',
    buttons,
  });

  return shouldRetry;
}
