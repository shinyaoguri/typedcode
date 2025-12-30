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

/** ファイルの種類 */
export type FileType = 'proof' | 'plaintext';

/** 解析済みファイルデータ */
export interface ParsedFileData {
  /** ファイル名 */
  filename: string;
  /** ファイルの種類 */
  type: FileType;
  /** 言語（proof の場合は検証言語、plaintext の場合はファイル拡張子から推測） */
  language: string;
  /** 生データ（文字列） */
  rawData: string;
  /** 解析済みデータ（proof の場合のみ） */
  proofData?: ProofFile;
  /** フォルダ内の相対パス */
  relativePath?: string;
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

      const language = this.getLanguageFromExtension(file.name);

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
          type: 'proof',
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

      // ZIPファイル名をルートフォルダ名として使用
      const rootFolderName = file.name.replace(/\.zip$/i, '');

      // フォルダ階層情報を収集
      const folderPathsSet = new Set<string>();

      // 全ファイルを抽出
      const files: ParsedFileData[] = [];

      for (const [path, zipEntry] of Object.entries(zip.files)) {
        if (zipEntry.dir) {
          // ディレクトリエントリを記録
          folderPathsSet.add(path.replace(/\/$/, ''));
          continue;
        }

        const filename = path.split('/').pop() ?? path;

        // パスからフォルダ階層を抽出
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) {
          folderPathsSet.add(parts.slice(0, i).join('/'));
        }

        // バイナリファイルはスキップ（テキストファイルのみ処理）
        if (this.isBinaryFile(filename)) continue;

        const content = await zipEntry.async('string');

        // JSONファイルの場合、証明ファイルかどうかをチェック
        if (filename.endsWith('.json')) {
          let language = 'unknown';
          let isValidProofFile = false;
          let proofData: ProofFile | undefined;

          try {
            const parsed = JSON.parse(content) as ProofFile;
            // proof フィールドがあれば証明ファイルとみなす
            if (parsed.proof) {
              isValidProofFile = true;
              proofData = parsed;
              language = parsed.language ?? 'unknown';
            }
          } catch {
            // パース失敗は無視（通常のJSONとして扱う）
          }

          if (isValidProofFile) {
            files.push({
              filename,
              type: 'proof',
              language,
              rawData: content,
              proofData,
              relativePath: path,
            });
          } else {
            // 証明ファイルではない通常のJSONファイル
            files.push({
              filename,
              type: 'plaintext',
              language: 'json',
              rawData: content,
              relativePath: path,
            });
          }
        } else {
          // JSON以外のファイル（C、TypeScript、Pythonなど）
          const language = this.getLanguageFromExtension(filename);
          files.push({
            filename,
            type: 'plaintext',
            language,
            rawData: content,
            relativePath: path,
          });
        }
      }

      this.callbacks.onZipExtract?.(file.name, files.length);

      if (files.length === 0) {
        return {
          success: false,
          mode: 'multi',
          files: [],
          error: 'ZIPにファイルがありません。',
        };
      }

      return {
        success: true,
        mode: 'multi',
        files,
        rootFolderName,
        folderPaths: Array.from(folderPathsSet),
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
   * （任意のJSONファイルを許可）
   */
  static isProofFilename(filename: string): boolean {
    return filename.endsWith('.json');
  }

  /**
   * バイナリファイルかどうかを判定
   */
  private isBinaryFile(filename: string): boolean {
    const binaryExtensions = [
      '.exe', '.dll', '.so', '.dylib', '.bin',
      '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
      '.mp3', '.mp4', '.wav', '.avi', '.mov', '.webm',
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
      '.zip', '.tar', '.gz', '.rar', '.7z',
      '.wasm', '.o', '.a', '.lib',
    ];
    const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
    return binaryExtensions.includes(ext);
  }

  /**
   * ファイル拡張子から言語を推測
   */
  public getLanguageFromExtension(filename: string): string {
    const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
    const languageMap: Record<string, string> = {
      '.c': 'c',
      '.h': 'c',
      '.cpp': 'cpp',
      '.cc': 'cpp',
      '.cxx': 'cpp',
      '.hpp': 'cpp',
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.py': 'python',
      '.rb': 'ruby',
      '.rs': 'rust',
      '.go': 'go',
      '.java': 'java',
      '.kt': 'kotlin',
      '.swift': 'swift',
      '.cs': 'csharp',
      '.php': 'php',
      '.html': 'html',
      '.htm': 'html',
      '.css': 'css',
      '.scss': 'scss',
      '.sass': 'sass',
      '.less': 'less',
      '.md': 'markdown',
      '.json': 'json',
      '.xml': 'xml',
      '.yaml': 'yaml',
      '.yml': 'yaml',
      '.toml': 'toml',
      '.sh': 'shell',
      '.bash': 'shell',
      '.zsh': 'shell',
      '.sql': 'sql',
      '.txt': 'plaintext',
    };
    return languageMap[ext] || 'plaintext';
  }
}
