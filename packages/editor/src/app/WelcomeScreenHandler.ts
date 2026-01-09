/**
 * WelcomeScreenHandler - ウェルカム画面の管理
 * ウェルカム画面の表示/非表示とイベント処理を担当
 */

import type { AppContext } from '../core/AppContext.js';
import { WelcomeScreen } from '../ui/components/WelcomeScreen.js';
import { t } from '../i18n/index.js';

/**
 * ウェルカム画面を表示
 */
export function showWelcomeScreen(ctx: AppContext): void {
  // Monacoエディタを非表示
  const editorEl = document.getElementById('editor');
  if (editorEl) editorEl.style.display = 'none';

  // コピーボタンを非表示（ファイルがないため）
  const copyCodeBtn = document.getElementById('copy-code-btn');
  if (copyCodeBtn) copyCodeBtn.style.display = 'none';

  // エディタコンテナにウェルカム画面を表示
  const container = document.querySelector('.editor-container') as HTMLElement | null;
  if (container && !ctx.welcomeScreen) {
    ctx.welcomeScreen = new WelcomeScreen({
      container,
      onNewFile: () => handleWelcomeNewFile(ctx),
      onImportTemplate: () => handleWelcomeImportTemplate(ctx),
    });
    ctx.welcomeScreen.show();
  }
}

/**
 * ウェルカム画面を非表示
 */
export function hideWelcomeScreen(ctx: AppContext): void {
  if (ctx.welcomeScreen) {
    ctx.welcomeScreen.hide();
    ctx.welcomeScreen.dispose();
    ctx.welcomeScreen = null;
  }

  // Monacoエディタを表示
  const editorEl = document.getElementById('editor');
  if (editorEl) editorEl.style.display = '';

  // コピーボタンを表示（ファイルが存在するため）
  const copyCodeBtn = document.getElementById('copy-code-btn');
  if (copyCodeBtn) copyCodeBtn.style.display = '';
}

/**
 * ウェルカム画面から新規ファイル作成
 */
async function handleWelcomeNewFile(ctx: AppContext): Promise<void> {
  const { showNotification, initializeLogViewer } = await import('./AppHelpers.js');

  hideWelcomeScreen(ctx);

  const num = ctx.tabUIController?.getNextUntitledNumber() ?? 1;
  const newTab = await ctx.tabManager?.createTab(`Untitled-${num}`, 'c', '');

  if (!newTab) {
    // 認証失敗時はウェルカム画面に戻る
    showWelcomeScreen(ctx);
    showNotification(t('notifications.authFailed'));
    return;
  }

  // スクリーンショットのキャプチャを再有効化
  ctx.trackers.screenshot?.setCaptureEnabled(true);

  // LogViewerが未初期化の場合は初期化
  initializeLogViewer(ctx);

  ctx.tabUIController?.updateUI();
  showNotification(t('notifications.newTabCreated'));
}

/**
 * ウェルカム画面からテンプレート読み込み
 */
async function handleWelcomeImportTemplate(ctx: AppContext): Promise<void> {
  const { handleTemplateImport, initializeLogViewer } = await import('./AppHelpers.js');

  await handleTemplateImport(ctx);

  // テンプレート読み込み成功時はウェルカム画面を非表示
  if (ctx.tabManager?.hasAnyTabs()) {
    hideWelcomeScreen(ctx);
    ctx.tabUIController?.updateUI();
    // スクリーンショットのキャプチャを再有効化
    ctx.trackers.screenshot?.setCaptureEnabled(true);
    // LogViewerが未初期化の場合は初期化
    initializeLogViewer(ctx);
  }
}
