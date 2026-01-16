/**
 * FileProcessor - ファイル処理サービス（ファサード）
 *
 * JSON/ZIPファイルの読み込みと解析を統一的に処理します。
 * 実際の処理は JsonFileProcessor / ZipFileProcessor に委譲。
 */

import type { ProofFile, VerifyScreenshot } from '../types.js';
import { ScreenshotService } from './ScreenshotService.js';
import { JsonFileProcessor } from './JsonFileProcessor.js';
import { ZipFileProcessor } from './ZipFileProcessor.js';
import { getFileType, isProofFilename, getLanguageFromExtension } from './fileUtils.js';

// 再エクスポート（利用側の互換性のため）
export { JsonFileProcessor } from './JsonFileProcessor.js';
export { ZipFileProcessor } from './ZipFileProcessor.js';
export * from './fileUtils.js';

// ============================================================================
// 型定義
// ============================================================================

/** ファイルの種類 */
export type FileType = 'proof' | 'plaintext' | 'image';

/** 解析済みファイルデータ */
export interface ParsedFileData {
  /** ファイル名 */
  filename: string;
  /** ファイルの種類 */
  type: FileType;
  /** 言語（proof の場合は検証言語、plaintext の場合はファイル拡張子から推測） */
  language: string;
  /** 生データ（文字列、画像の場合は空） */
  rawData: string;
  /** 解析済みデータ（proof の場合のみ） */
  proofData?: ProofFile;
  /** フォルダ内の相対パス */
  relativePath?: string;
  /** 画像Blob（image の場合のみ） */
  imageBlob?: Blob;
}

/** ファイル処理結果 */
export interface FileProcessResult {
  /** 成功したかどうか */
  success: boolean;
  /** 処理モード */
  mode: 'single' | 'multi';
  /** 解析済みファイル一覧 */
  files: ParsedFileData[];
  /** エラーメッセージ（失敗時） */
  error?: string;
  /** ZIPファイルのルートフォルダ名 */
  rootFolderName?: string;
  /** ZIPファイル内のフォルダパス一覧 */
  folderPaths?: string[];
  /** スクリーンショット一覧（ZIPに含まれている場合） */
  screenshots?: VerifyScreenshot[];
  /** スクリーンショットサービス（ZIPに含まれている場合） */
  screenshotService?: ScreenshotService;
  /** 記録開始時刻（Unix timestamp ms）- チャートX軸表示用 */
  startTimestamp?: number;
}

/** 処理進捗コールバック */
export interface FileProcessCallbacks {
  /** ファイル読み込み開始 */
  onReadStart?: (filename: string) => void;
  /** ファイル読み込み完了 */
  onReadComplete?: (filename: string, sizeKb: number) => void;
  /** JSON解析完了 */
  onParseComplete?: (filename: string, eventCount: number) => void;
  /** ZIP展開進捗 */
  onZipExtract?: (filename: string, fileCount: number) => void;
  /** スクリーンショット読み込み */
  onScreenshotLoad?: (count: number, verifiedCount: number) => void;
  /** エラー発生 */
  onError?: (filename: string, error: string) => void;
}

// ============================================================================
// FileProcessor クラス
// ============================================================================

/**
 * ファイル処理サービス（ファサード）
 *
 * JSON/ZIP の処理を専用クラスに委譲し、統一的なインターフェースを提供
 */
export class FileProcessor {
  private callbacks: FileProcessCallbacks;
  private jsonProcessor: JsonFileProcessor;
  private zipProcessor: ZipFileProcessor;

  constructor(callbacks: FileProcessCallbacks = {}) {
    this.callbacks = callbacks;
    this.jsonProcessor = new JsonFileProcessor(callbacks);
    this.zipProcessor = new ZipFileProcessor(callbacks);
  }

  /**
   * コールバックを設定
   */
  setCallbacks(callbacks: FileProcessCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
    this.jsonProcessor.setCallbacks(this.callbacks);
    this.zipProcessor.setCallbacks(this.callbacks);
  }

  /**
   * ファイルを処理（JSON/ZIP自動判定）
   */
  async process(file: File, forceMultiMode: boolean = false): Promise<FileProcessResult> {
    if (file.name.endsWith('.zip')) {
      return this.zipProcessor.process(file);
    } else if (file.name.endsWith('.json')) {
      return this.jsonProcessor.process(file, forceMultiMode);
    } else {
      // JSONでもZIPでもない場合はプレーンテキストとして処理
      return this.processPlaintext(file);
    }
  }

  /**
   * FileSystemFileHandle からファイルを処理
   */
  async processFromHandle(
    handle: FileSystemFileHandle,
    relativePath: string
  ): Promise<FileProcessResult> {
    const file = await handle.getFile();
    const result = await this.process(file, true);

    // 相対パスを追加
    if (result.success) {
      result.files = result.files.map((f) => ({
        ...f,
        relativePath,
      }));
    }

    return result;
  }

  /**
   * プレーンテキストファイルを処理
   */
  async processPlaintext(
    file: File,
    relativePath?: string
  ): Promise<FileProcessResult> {
    this.callbacks.onReadStart?.(file.name);

    try {
      const text = await file.text();
      const sizeKb = text.length / 1024;
      this.callbacks.onReadComplete?.(file.name, sizeKb);

      const language = getLanguageFromExtension(file.name);

      return {
        success: true,
        mode: 'single',
        files: [
          {
            filename: file.name,
            type: 'plaintext',
            language,
            rawData: text,
            relativePath,
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.callbacks.onError?.(file.name, errorMessage);
      return {
        success: false,
        mode: 'single',
        files: [],
        error: `ファイル読み込みに失敗しました: ${errorMessage}`,
      };
    }
  }

  /**
   * JSONファイルを処理（後方互換性のため維持）
   */
  async processJson(file: File, forceMultiMode: boolean = false): Promise<FileProcessResult> {
    return this.jsonProcessor.process(file, forceMultiMode);
  }

  /**
   * ZIPファイルを処理（後方互換性のため維持）
   */
  async processZip(file: File): Promise<FileProcessResult> {
    return this.zipProcessor.process(file);
  }

  /**
   * ファイル拡張子からファイルタイプを判定
   */
  static getFileType(filename: string): 'json' | 'zip' | 'unknown' {
    return getFileType(filename);
  }

  /**
   * 証明ファイルのファイル名パターンにマッチするか
   */
  static isProofFilename(filename: string): boolean {
    return isProofFilename(filename);
  }

  /**
   * ファイル拡張子から言語を推測（後方互換性のため維持）
   */
  public getLanguageFromExtension(filename: string): string {
    return getLanguageFromExtension(filename);
  }
}
