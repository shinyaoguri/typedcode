/**
 * TemplateParser - テンプレートファイルのパース
 * YAML形式のテンプレートファイルを解析してParsedTemplateに変換
 */

import { parse as parseYaml } from 'yaml';
import type { ParsedTemplate, TemplateFileDefinition, TemplateMetadata } from '@typedcode/shared';

/** サポートされている言語ID */
const SUPPORTED_LANGUAGES = new Set([
  'c', 'cpp', 'javascript', 'typescript', 'python',
  'java', 'rust', 'go', 'ruby', 'php',
  'html', 'css', 'json', 'yaml', 'xml',
  'markdown', 'plaintext', 'sql', 'shell', 'bash'
]);

/** テンプレートのバリデーションエラー */
export class TemplateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateValidationError';
  }
}

/** テンプレートの制限 */
const TEMPLATE_LIMITS = {
  MAX_FILES: 20,
  MAX_CONTENT_SIZE: 100 * 1024, // 100KB
  MAX_FILENAME_LENGTH: 255,
};

export class TemplateParser {
  /**
   * テンプレートファイルをパース
   * @param content - テンプレートファイルの内容（YAML）
   * @returns パース済みテンプレート
   * @throws TemplateValidationError - バリデーションエラー
   */
  parse(content: string): ParsedTemplate {
    let parsed: unknown;

    try {
      // 空文字列チェック
      if (!content || content.trim() === '') {
        throw new TemplateValidationError('テンプレートファイルが空です');
      }

      parsed = parseYaml(content);
      console.log('[TemplateParser] Parsed YAML:', parsed, 'Type:', typeof parsed);
    } catch (error) {
      if (error instanceof TemplateValidationError) {
        throw error;
      }
      throw new TemplateValidationError(
        `YAMLパースエラー: ${error instanceof Error ? error.message : '不明なエラー'}`
      );
    }

    return this.validate(parsed);
  }

  /**
   * パースされたデータをバリデート
   */
  private validate(data: unknown): ParsedTemplate {
    if (!data || typeof data !== 'object') {
      throw new TemplateValidationError('テンプレートはオブジェクトである必要があります');
    }

    const obj = data as Record<string, unknown>;

    // version チェック
    const version = this.validateVersion(obj.version);

    // metadata チェック（オプショナル）
    const metadata = this.validateMetadata(obj.metadata);

    // files チェック（必須）
    const files = this.validateFiles(obj.files);

    return {
      version,
      metadata,
      files,
    };
  }

  /**
   * バージョンをバリデート
   */
  private validateVersion(version: unknown): string {
    if (version === undefined || version === null) {
      return '1.0'; // デフォルトバージョン
    }
    if (typeof version !== 'string') {
      throw new TemplateValidationError('versionは文字列である必要があります');
    }
    return version;
  }

  /**
   * メタデータをバリデート
   */
  private validateMetadata(metadata: unknown): TemplateMetadata {
    if (metadata === undefined || metadata === null) {
      return {}; // 空のメタデータ
    }
    if (typeof metadata !== 'object') {
      throw new TemplateValidationError('metadataはオブジェクトである必要があります');
    }

    const obj = metadata as Record<string, unknown>;
    const result: TemplateMetadata = {};

    if (obj.name !== undefined) {
      if (typeof obj.name !== 'string') {
        throw new TemplateValidationError('metadata.nameは文字列である必要があります');
      }
      result.name = obj.name;
    }

    if (obj.author !== undefined) {
      if (typeof obj.author !== 'string') {
        throw new TemplateValidationError('metadata.authorは文字列である必要があります');
      }
      result.author = obj.author;
    }

    if (obj.description !== undefined) {
      if (typeof obj.description !== 'string') {
        throw new TemplateValidationError('metadata.descriptionは文字列である必要があります');
      }
      result.description = obj.description;
    }

    return result;
  }

  /**
   * ファイル定義をバリデート
   */
  private validateFiles(files: unknown): TemplateFileDefinition[] {
    if (!Array.isArray(files)) {
      throw new TemplateValidationError('filesは配列である必要があります');
    }

    if (files.length === 0) {
      throw new TemplateValidationError('テンプレートには少なくとも1つのファイルが必要です');
    }

    if (files.length > TEMPLATE_LIMITS.MAX_FILES) {
      throw new TemplateValidationError(
        `ファイル数が上限（${TEMPLATE_LIMITS.MAX_FILES}）を超えています`
      );
    }

    const filenames = new Set<string>();
    const result: TemplateFileDefinition[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const validated = this.validateFileDefinition(file, i);

      // 重複ファイル名チェック
      if (filenames.has(validated.filename)) {
        throw new TemplateValidationError(
          `重複したファイル名: ${validated.filename}`
        );
      }
      filenames.add(validated.filename);

      result.push(validated);
    }

    return result;
  }

  /**
   * 単一のファイル定義をバリデート
   */
  private validateFileDefinition(file: unknown, index: number): TemplateFileDefinition {
    if (!file || typeof file !== 'object') {
      throw new TemplateValidationError(
        `files[${index}]はオブジェクトである必要があります`
      );
    }

    const obj = file as Record<string, unknown>;

    // filename チェック（必須）
    if (typeof obj.filename !== 'string' || obj.filename.trim() === '') {
      throw new TemplateValidationError(
        `files[${index}].filenameは空でない文字列である必要があります`
      );
    }
    const filename = obj.filename.trim();

    if (filename.length > TEMPLATE_LIMITS.MAX_FILENAME_LENGTH) {
      throw new TemplateValidationError(
        `files[${index}].filenameが長すぎます（最大${TEMPLATE_LIMITS.MAX_FILENAME_LENGTH}文字）`
      );
    }

    // 危険な文字をチェック
    if (/[<>:"|?*\x00-\x1f]/.test(filename) || filename.includes('..')) {
      throw new TemplateValidationError(
        `files[${index}].filenameに無効な文字が含まれています`
      );
    }

    // language チェック（必須）
    if (typeof obj.language !== 'string' || obj.language.trim() === '') {
      throw new TemplateValidationError(
        `files[${index}].languageは空でない文字列である必要があります`
      );
    }
    let language = obj.language.trim().toLowerCase();

    // サポートされていない言語はplaintextにフォールバック
    if (!SUPPORTED_LANGUAGES.has(language)) {
      console.warn(
        `[TemplateParser] サポートされていない言語 "${language}" をplaintextにフォールバック`
      );
      language = 'plaintext';
    }

    // content チェック（オプショナル、デフォルトは空文字列）
    let content = '';
    if (obj.content !== undefined) {
      if (typeof obj.content !== 'string') {
        throw new TemplateValidationError(
          `files[${index}].contentは文字列である必要があります`
        );
      }
      content = obj.content;

      if (content.length > TEMPLATE_LIMITS.MAX_CONTENT_SIZE) {
        throw new TemplateValidationError(
          `files[${index}].contentが大きすぎます（最大${TEMPLATE_LIMITS.MAX_CONTENT_SIZE / 1024}KB）`
        );
      }
    }

    return {
      filename,
      language,
      content,
    };
  }
}
