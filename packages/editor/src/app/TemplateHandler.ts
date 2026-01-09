/**
 * TemplateHandler - テンプレートインポート処理
 */

import type { AppContext } from '../core/AppContext.js';
import { t } from '../i18n/index.js';
import { showNotification } from './AppHelpers.js';

/**
 * テンプレートファイルかどうかを判定
 */
export function isTemplateFile(file: File): boolean {
  const ext = file.name.toLowerCase().split('.').pop();
  return ext === 'yaml' || ext === 'yml';
}

/**
 * テンプレートコンテンツをインポート（共通処理）
 */
export async function importTemplateContent(
  ctx: AppContext,
  content: string
): Promise<boolean> {
  const { templateImportDialog } = await import('../template/TemplateImportDialog.js');
  const { templateImporter } = await import('../template/TemplateImporter.js');
  const { TemplateValidationError } = await import('../template/TemplateParser.js');

  if (!ctx.tabManager) return false;

  // 1. テンプレートをパース
  let template;
  try {
    template = templateImporter.parseTemplate(content);
  } catch (error: unknown) {
    if (error instanceof TemplateValidationError) {
      showNotification(error.message);
    } else {
      console.error('[TemplateImport] Parse error:', error);
      showNotification(t('template.invalidFormat'));
    }
    return false;
  }

  // 2. 確認ダイアログ
  const hasExistingTabs = ctx.tabManager.getAllTabs().length > 0;
  const confirmed = await templateImportDialog.showConfirmation(template, hasExistingTabs);
  if (!confirmed) return false;

  // 3. 進捗表示
  const progress = templateImportDialog.showProgress();

  try {
    // 4. インポート実行
    const result = await templateImporter.import(
      ctx.tabManager,
      content,
      (current, total, currentFilename) => {
        progress.update(current, total, currentFilename);
      }
    );

    progress.close();

    // 5. 結果表示
    if (result.success) {
      showNotification(t('template.success', { count: result.filesCreated }));
      ctx.tabUIController?.updateUI();
    } else {
      console.error('[TemplateImport] Errors:', result.errors);
      showNotification(t('template.partialSuccess', { count: result.filesCreated }));
    }

    return result.success;
  } catch (error) {
    progress.close();
    throw error;
  }
}

/**
 * ドラッグ＆ドロップでテンプレートをインポート
 */
export async function handleTemplateDrop(ctx: AppContext, file: File): Promise<void> {
  if (!ctx.tabManager) return;

  // ファイル内容を読み取り
  let content: string;
  try {
    content = await file.text();
  } catch {
    showNotification(t('template.readError'));
    return;
  }

  // インポート処理
  await importTemplateContent(ctx, content);
}
