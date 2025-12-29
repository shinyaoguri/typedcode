/**
 * FileProcessor - ファイル処理サービス
 *
 * JSON/ZIPファイルの読み込みと解析を統一的に処理します。
 * main.ts の3つのファイル処理パスを統合。
 */

import JSZip from 'jszip';
import type { ProofFile } from '../types.js';

// ============================================================================
// 型定義
// ============================================================================

/** 解析済みファイルデータ */
export interface ParsedFileData {
  /** ファイル名 */
  filename: string;
  /** 言語 */
  language: string;
  /** 生データ（JSON文字列） */
  rawData: string;
  /** 解析済みデータ（オプション） */
  proofData?: ProofFile;
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
  /** エラー発生 */
  onError?: (filename: string, error: string) => void;
}

// ============================================================================
// FileProcessor クラス
// ============================================================================

/**
 * ファイル処理サービス
 */
export class FileProcessor {
  private callbacks: FileProcessCallbacks;

  constructor(callbacks: FileProcessCallbacks = {}) {
    this.callbacks = callbacks;
  }

  /**
   * コールバックを設定
   */
  setCallbacks(callbacks: FileProcessCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  /**
   * ファイルを処理（JSON/ZIP自動判定）
   */
  async process(file: File, forceMultiMode: boolean = false): Promise<FileProcessResult> {
    if (file.name.endsWith('.zip')) {
      return this.processZip(file);
    } else if (file.name.endsWith('.json')) {
      return this.processJson(file, forceMultiMode);
    } else {
      return {
        success: false,
        mode: 'single',
        files: [],
        error: '対応していないファイル形式です。.json または .zip ファイルを選択してください',
      };
    }
  }

  /**
   * JSONファイルを処理
   */
  async processJson(file: File, forceMultiMode: boolean = false): Promise<FileProcessResult> {
    this.callbacks.onReadStart?.(file.name);

    try {
      const text = await file.text();
      const sizeKb = text.length / 1024;
      this.callbacks.onReadComplete?.(file.name, sizeKb);

      // 言語を取得
      let language = 'unknown';
      let proofData: ProofFile | undefined;

      try {
        proofData = JSON.parse(text) as ProofFile;
        language = proofData.language ?? 'unknown';
        const eventCount = proofData.proof?.events?.length ?? 0;
        this.callbacks.onParseComplete?.(file.name, eventCount);
      } catch (parseError) {
        // パース失敗
        const errorMessage = parseError instanceof Error ? parseError.message : String(parseError);
        this.callbacks.onError?.(file.name, `JSON解析エラー: ${errorMessage}`);
        return {
          success: false,
          mode: forceMultiMode ? 'multi' : 'single',
          files: [],
          error: `JSON解析に失敗しました: ${errorMessage}`,
        };
      }

      return {
        success: true,
        mode: forceMultiMode ? 'multi' : 'single',
        files: [{
          filename: file.name,
          language,
          rawData: text,
          proofData,
        }],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.callbacks.onError?.(file.name, errorMessage);
      return {
        success: false,
        mode: forceMultiMode ? 'multi' : 'single',
        files: [],
        error: `ファイル読み込みに失敗しました: ${errorMessage}`,
      };
    }
  }

  /**
   * ZIPファイルを処理
   */
  async processZip(file: File): Promise<FileProcessResult> {
    this.callbacks.onReadStart?.(file.name);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const sizeKb = arrayBuffer.byteLength / 1024;
      this.callbacks.onReadComplete?.(file.name, sizeKb);

      const zip = await JSZip.loadAsync(arrayBuffer);

      // TC_*.json ファイルを抽出
      const files: ParsedFileData[] = [];

      for (const [path, zipEntry] of Object.entries(zip.files)) {
        if (zipEntry.dir) continue;

        // TC_*.json パターンにマッチするか確認
        const filename = path.split('/').pop() ?? path;
        if (filename.match(/^TC_.*\.json$/)) {
          const content = await zipEntry.async('string');

          // 言語を取得
          let language = 'unknown';
          try {
            const parsed = JSON.parse(content) as ProofFile;
            language = parsed.language ?? 'unknown';
          } catch {
            // パース失敗は無視（検証時にエラーになる）
          }

          files.push({
            filename,
            language,
            rawData: content,
          });
        }
      }

      this.callbacks.onZipExtract?.(file.name, files.length);

      if (files.length === 0) {
        return {
          success: false,
          mode: 'multi',
          files: [],
          error: 'ZIPに証明ファイルがありません。TC_*.json パターンのファイルが含まれていません',
        };
      }

      return {
        success: true,
        mode: 'multi',
        files,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.callbacks.onError?.(file.name, errorMessage);
      return {
        success: false,
        mode: 'multi',
        files: [],
        error: `ZIPファイルの読み込みに失敗しました: ${errorMessage}`,
      };
    }
  }

  /**
   * ファイル拡張子からファイルタイプを判定
   */
  static getFileType(filename: string): 'json' | 'zip' | 'unknown' {
    if (filename.endsWith('.json')) return 'json';
    if (filename.endsWith('.zip')) return 'zip';
    return 'unknown';
  }

  /**
   * 証明ファイルのファイル名パターンにマッチするか
   */
  static isProofFilename(filename: string): boolean {
    return /^TC_.*\.json$/.test(filename);
  }
}
