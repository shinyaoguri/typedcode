/**
 * JsonFileProcessor - JSON ファイル処理サービス
 *
 * JSON ファイルの読み込みと解析を担当
 */

import type { ProofFile } from '../types.js';
import type { ParsedFileData, FileProcessResult, FileProcessCallbacks } from './FileProcessor.js';
import { getLanguageFromExtension } from './fileUtils.js';

/**
 * JSON ファイル処理クラス
 */
export class JsonFileProcessor {
  constructor(private callbacks: FileProcessCallbacks = {}) {}

  /**
   * コールバックを更新
   */
  setCallbacks(callbacks: FileProcessCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  /**
   * JSON ファイルを処理
   */
  async process(file: File, forceMultiMode: boolean = false): Promise<FileProcessResult> {
    this.callbacks.onReadStart?.(file.name);

    try {
      const text = await file.text();
      const sizeKb = text.length / 1024;
      this.callbacks.onReadComplete?.(file.name, sizeKb);

      // JSONをパースして proof フィールドがあるかどうかを判定
      let language = 'unknown';
      let proofData: ProofFile | undefined;
      let isValidProofFile = false;

      try {
        const parsed = JSON.parse(text) as ProofFile;
        // proof フィールドがあれば証明ファイルとみなす
        if (parsed.proof) {
          isValidProofFile = true;
          proofData = parsed;
          language = parsed.language ?? 'unknown';
          const eventCount = parsed.proof?.events?.length ?? 0;
          this.callbacks.onParseComplete?.(file.name, eventCount);
        }
      } catch {
        // パース失敗 - プレーンテキストとして扱う
        const lang = getLanguageFromExtension(file.name);
        return {
          success: true,
          mode: forceMultiMode ? 'multi' : 'single',
          files: [{
            filename: file.name,
            type: 'plaintext',
            language: lang,
            rawData: text,
          }],
        };
      }

      if (isValidProofFile) {
        return {
          success: true,
          mode: forceMultiMode ? 'multi' : 'single',
          files: [{
            filename: file.name,
            type: 'proof',
            language,
            rawData: text,
            proofData,
          }],
        };
      } else {
        // proof フィールドがない通常のJSONファイル - プレーンテキストとして扱う
        return {
          success: true,
          mode: forceMultiMode ? 'multi' : 'single',
          files: [{
            filename: file.name,
            type: 'plaintext',
            language: 'json',
            rawData: text,
          }],
        };
      }
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
   * JSON 文字列からプルーフデータを解析
   */
  parseProofFromString(content: string, filename: string): ParsedFileData | null {
    try {
      const parsed = JSON.parse(content) as ProofFile;
      if (parsed.proof) {
        return {
          filename,
          type: 'proof',
          language: parsed.language ?? 'unknown',
          rawData: content,
          proofData: parsed,
        };
      }
      return null;
    } catch {
      return null;
    }
  }
}
