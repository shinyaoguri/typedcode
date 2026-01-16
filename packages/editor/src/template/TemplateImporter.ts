/**
 * TemplateImporter - テンプレートインポート処理
 * テンプレートファイルを読み込み、複数タブを作成してtemplateInjectionイベントを記録
 */

import type { TabManager } from '../ui/tabs/TabManager.js';
import type {
  ParsedTemplate,
  TemplateInjectionEventData,
} from '@typedcode/shared';
import { TemplateParser, TemplateValidationError } from './TemplateParser.js';

/** インポート結果 */
export interface TemplateImportResult {
  success: boolean;
  filesCreated: number;
  templateName: string;
  errors: string[];
}

/** インポート進捗コールバック */
export type ImportProgressCallback = (current: number, total: number, filename: string) => void;

export class TemplateImporter {
  private parser: TemplateParser;

  constructor() {
    this.parser = new TemplateParser();
  }

  /**
   * SHA-256ハッシュを計算
   */
  private async computeHash(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * テンプレートファイルの内容をパース
   * @param content - テンプレートファイルの内容
   * @returns パース済みテンプレート
   * @throws TemplateValidationError
   */
  parseTemplate(content: string): ParsedTemplate {
    return this.parser.parse(content);
  }

  /**
   * テンプレートをインポート
   * @param tabManager - TabManager インスタンス
   * @param templateContent - テンプレートファイルの内容
   * @param onProgress - 進捗コールバック
   * @returns インポート結果
   */
  async import(
    tabManager: TabManager,
    templateContent: string,
    onProgress?: ImportProgressCallback
  ): Promise<TemplateImportResult> {
    const result: TemplateImportResult = {
      success: false,
      filesCreated: 0,
      templateName: '',
      errors: [],
    };

    // 1. テンプレートをパース
    let template: ParsedTemplate;
    try {
      template = this.parseTemplate(templateContent);
    } catch (error) {
      if (error instanceof TemplateValidationError) {
        result.errors.push(error.message);
      } else {
        result.errors.push('テンプレートのパースに失敗しました');
      }
      return result;
    }

    const templateName = template.metadata.name ?? 'Unnamed Template';
    result.templateName = templateName;

    // 2. テンプレート全体のハッシュを計算
    const templateHash = await this.computeHash(templateContent);

    // 3. 既存タブをすべて閉じる
    await tabManager.closeAllTabs();

    // 4. 最初のファイルを作成（Turnstile認証付き）
    const firstFile = template.files[0]!;
    onProgress?.(1, template.files.length, firstFile.filename);

    const firstTab = await tabManager.createTab(
      firstFile.filename,
      firstFile.language,
      firstFile.content
    );

    if (!firstTab) {
      result.errors.push('最初のファイルの作成に失敗しました（認証エラー）');
      return result;
    }

    // 最初のファイルにtemplateInjectionイベントを記録
    const firstContentHash = await this.computeHash(firstFile.content);
    const firstInjectionData: TemplateInjectionEventData = {
      templateName,
      templateHash,
      filename: firstFile.filename,
      content: firstFile.content,
      contentHash: firstContentHash,
      contentLength: firstFile.content.length,
      totalFilesInTemplate: template.files.length,
      injectionSource: 'file_import',
    };
    await firstTab.typingProof.recordTemplateInjection(firstInjectionData);
    result.filesCreated++;

    // 人間認証データを取得（2番目以降のファイルで共有）
    const sharedAttestation = firstTab.typingProof.getHumanAttestation();

    // 5. 残りのファイルを作成（認証スキップ）
    for (let i = 1; i < template.files.length; i++) {
      const file = template.files[i]!;
      onProgress?.(i + 1, template.files.length, file.filename);

      try {
        const tab = await tabManager.createTabFromTemplate(
          file.filename,
          file.language,
          file.content,
          sharedAttestation
        );

        if (tab) {
          // templateInjectionイベントを記録
          const contentHash = await this.computeHash(file.content);
          const injectionData: TemplateInjectionEventData = {
            templateName,
            templateHash,
            filename: file.filename,
            content: file.content,
            contentHash,
            contentLength: file.content.length,
            totalFilesInTemplate: template.files.length,
            injectionSource: 'file_import',
          };
          await tab.typingProof.recordTemplateInjection(injectionData);
          result.filesCreated++;
        } else {
          result.errors.push(`${file.filename}の作成に失敗しました`);
        }
      } catch (error) {
        result.errors.push(
          `${file.filename}の作成中にエラー: ${error instanceof Error ? error.message : '不明'}`
        );
      }
    }

    // 6. 最初のタブをアクティブに
    if (firstTab) {
      await tabManager.switchTab(firstTab.id);
    }

    result.success = result.errors.length === 0;
    return result;
  }
}

// シングルトンエクスポート
export const templateImporter = new TemplateImporter();
