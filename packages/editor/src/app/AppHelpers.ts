/**
 * AppHelpers - アプリケーション共通ヘルパー関数
 */

import type { AppContext } from '../core/AppContext.js';
import { LogViewer } from '../ui/components/LogViewer.js';
import { t } from '../i18n/index.js';

/**
 * 通知メッセージを表示
 */
export function showNotification(message: string): void {
  const blockNotificationEl = document.getElementById('block-notification');
  const blockMessageEl = document.getElementById('block-message');
  if (blockMessageEl) blockMessageEl.textContent = message;
  blockNotificationEl?.classList.remove('hidden');
  setTimeout(() => {
    blockNotificationEl?.classList.add('hidden');
  }, 2000);
}

/**
 * LogViewerを初期化
 */
export function initializeLogViewer(ctx: AppContext): void {
  // すでに初期化済みの場合はスキップ
  if (ctx.logViewer) return;

  const logEntriesContainer = document.getElementById('log-entries');
  if (!logEntriesContainer) {
    console.error('[TypedCode] log-entries not found!');
    return;
  }

  const initialProof = ctx.tabManager?.getActiveProof();
  if (initialProof) {
    ctx.logViewer = new LogViewer(logEntriesContainer, initialProof);

    // スクリーンショットストレージを設定（プレビュー表示用）
    if (ctx.trackers.screenshot) {
      ctx.logViewer.setScreenshotStorage(ctx.trackers.screenshot.getStorageService());
    }
  }
}

/**
 * 証明ステータスを更新
 */
export function updateProofStatus(ctx: AppContext): void {
  ctx.proofStatusDisplay.update();
}

/**
 * テンプレートインポート処理（ファイル選択ダイアログから）
 */
export async function handleTemplateImport(ctx: AppContext): Promise<void> {
  const { templateImportDialog } = await import('../template/TemplateImportDialog.js');

  if (!ctx.tabManager) return;

  // 1. ファイル選択
  const file = await templateImportDialog.selectFile();
  if (!file) return;

  // 2. ファイル内容を読み取り
  let content: string;
  try {
    content = await file.text();
  } catch {
    showNotification(t('template.readError'));
    return;
  }

  // 3. インポート処理
  const { importTemplateContent } = await import('./TemplateHandler.js');
  await importTemplateContent(ctx, content);
}
