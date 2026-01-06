/**
 * テンプレート関連の型定義
 */

/** テンプレート内のファイル定義 */
export interface TemplateFileDefinition {
  filename: string;
  language: string;
  content: string;
}

/** テンプレートメタデータ */
export interface TemplateMetadata {
  name?: string;
  author?: string;
  description?: string;
}

/** パース済みテンプレート */
export interface ParsedTemplate {
  version: string;
  metadata: TemplateMetadata;
  files: TemplateFileDefinition[];
}

/** テンプレート注入イベントデータ */
export interface TemplateInjectionEventData {
  templateName: string;           // テンプレート名
  templateHash: string;           // テンプレートファイル全体のSHA-256ハッシュ
  filename: string;               // 注入されたファイル名
  content: string;                // 注入されたコンテンツ（verify側での再構築用）
  contentHash: string;            // 注入されたコンテンツのハッシュ
  contentLength: number;          // コンテンツの長さ
  totalFilesInTemplate: number;   // テンプレート内の総ファイル数
  injectionSource: 'file_import'; // 注入元
}
