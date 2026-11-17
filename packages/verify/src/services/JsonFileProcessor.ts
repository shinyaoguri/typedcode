/**
 * JsonFileProcessor - JSON ファイル処理サービス
 *
 * JSON ファイルの読み込みと解析を担当
 */

import { isProofExportFilename, normalizeProofLanguage } from '@typedcode/shared';
import type { ProofFile } from '../types.js';
import type { ParsedFileData, FileProcessResult, FileProcessCallbacks } from './FileProcessor.js';
import { t } from '../i18n/index.js';

/**
 * JSON テキストを proof / 読めない proof / 通常の JSON に分ける。単体投入・フォルダ・ZIP の全経路がこれを通る (#702)。
 *
 * - `proof` フィールドがあれば proof (`proofData` 付き)
 * - proof の名前 (`*_proof.json` / `*_proof_N.json`, shared の `isProofExportFilename`) なのに proof として
 *   読めない (JSON 破損・proof 構造なし) ものは `type: 'proof'` のまま proofData 無しで返す (#292)。
 *   取り込み側 (`FileController.addFileToVerification`) が error のタブ/行にする。通常の JSON として
 *   success で並べると、壊れたタブが未検証のまま見落とされる
 * - それ以外は通常の JSON (plaintext)
 *
 * @param path 名前の判定に使うパス (ZIP 内のパスなど)。省くと `filename`
 */
export function classifyJsonText(content: string, filename: string, path: string = filename): ParsedFileData {
  let proofData: ProofFile | undefined;
  try {
    const parsed = JSON.parse(content) as ProofFile;
    // proof フィールドがあれば証明ファイルとみなす
    if (parsed.proof) proofData = parsed;
  } catch {
    // パース失敗: proof の名前でなければ通常の JSON として扱う (proof の名前なら下で読めない proof として返す)
  }

  if (proofData) {
    return {
      filename,
      type: 'proof',
      language: normalizeProofLanguage(proofData.language),
      rawData: content,
      proofData,
    };
  }
  if (isProofExportFilename(path)) {
    return { filename, type: 'proof', language: 'unknown', rawData: content };
  }
  return { filename, type: 'plaintext', language: 'json', rawData: content };
}

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

      const parsed = classifyJsonText(text, file.name);
      if (parsed.proofData) {
        this.callbacks.onParseComplete?.(file.name, parsed.proofData.proof?.events?.length ?? 0);
      }
      return {
        success: true,
        mode: forceMultiMode ? 'multi' : 'single',
        files: [parsed],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.callbacks.onError?.(file.name, errorMessage);
      return {
        success: false,
        mode: forceMultiMode ? 'multi' : 'single',
        files: [],
        error: t('errors.fileLoadFailed', { message: errorMessage }),
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
          language: normalizeProofLanguage(parsed.language),
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
