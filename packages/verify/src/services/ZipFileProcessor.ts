/**
 * ZipFileProcessor - ZIP ファイル処理サービス
 *
 * ZIP ファイルの展開と解析を担当
 */

import JSZip from 'jszip';
import type { ProofFile, ScreenshotManifest, VerifyScreenshot } from '../types.js';
import type { ParsedFileData, FileProcessResult, FileProcessCallbacks } from './FileProcessor.js';
import { ScreenshotService } from './ScreenshotService.js';
import { isImageFile, isBinaryFile, getLanguageFromExtension } from './fileUtils.js';

/**
 * ZIP ファイル処理クラス
 */
export class ZipFileProcessor {
  constructor(private callbacks: FileProcessCallbacks = {}) {}

  /**
   * コールバックを更新
   */
  setCallbacks(callbacks: FileProcessCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  /**
   * ZIP ファイルを処理
   */
  async process(file: File): Promise<FileProcessResult> {
    this.callbacks.onReadStart?.(file.name);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const sizeKb = arrayBuffer.byteLength / 1024;
      this.callbacks.onReadComplete?.(file.name, sizeKb);

      const zip = await JSZip.loadAsync(arrayBuffer);

      // ZIPファイル名をルートフォルダ名として使用
      const rootFolderName = file.name.replace(/\.zip$/i, '');

      // ファイルを抽出
      const { files, folderPaths } = await this.extractFiles(zip);

      this.callbacks.onZipExtract?.(file.name, files.length);

      // スクリーンショットを読み込み
      const { screenshots, screenshotService } = await this.loadScreenshots(zip);

      if (files.length === 0 && screenshots.length === 0) {
        return {
          success: false,
          mode: 'multi',
          files: [],
          error: 'ZIPにファイルがありません。',
        };
      }

      // 最初のプルーフファイルからstartTimestampを計算
      const startTimestamp = this.calculateStartTimestamp(files);

      return {
        success: true,
        mode: 'multi',
        files,
        rootFolderName,
        folderPaths,
        screenshots,
        screenshotService,
        startTimestamp,
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
   * ZIP からファイルを抽出
   */
  private async extractFiles(zip: JSZip): Promise<{
    files: ParsedFileData[];
    folderPaths: string[];
  }> {
    const folderPathsSet = new Set<string>();
    const files: ParsedFileData[] = [];

    for (const [path, zipEntry] of Object.entries(zip.files)) {
      if (zipEntry.dir) {
        // ディレクトリエントリを記録
        folderPathsSet.add(path.replace(/\/$/, ''));
        continue;
      }

      const filename = path.split('/').pop() ?? path;

      // 隠しファイル（.で始まるファイル）はスキップ
      if (filename.startsWith('.')) continue;

      // パスからフォルダ階層を抽出
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        folderPathsSet.add(parts.slice(0, i).join('/'));
      }

      // screenshots/ フォルダ内のファイルを処理
      if (path.startsWith('screenshots/')) {
        const parsed = await this.processScreenshotFile(zipEntry, filename, path);
        if (parsed) files.push(parsed);
        continue;
      }

      // 画像ファイルを処理
      if (isImageFile(filename)) {
        const blob = await zipEntry.async('blob');
        files.push({
          filename,
          type: 'image',
          language: 'image',
          rawData: '',
          relativePath: path,
          imageBlob: blob,
        });
        continue;
      }

      // その他のバイナリファイルはスキップ（テキストファイルのみ処理）
      if (isBinaryFile(filename)) continue;

      const content = await zipEntry.async('string');
      const parsed = this.parseTextFile(content, filename, path);
      files.push(parsed);
    }

    return { files, folderPaths: Array.from(folderPathsSet) };
  }

  /**
   * screenshots/ フォルダ内のファイルを処理
   */
  private async processScreenshotFile(
    zipEntry: JSZip.JSZipObject,
    filename: string,
    path: string
  ): Promise<ParsedFileData | null> {
    if (filename === 'manifest.json') {
      const content = await zipEntry.async('string');
      return {
        filename,
        type: 'plaintext',
        language: 'json',
        rawData: content,
        relativePath: path,
      };
    } else if (isImageFile(filename)) {
      const blob = await zipEntry.async('blob');
      return {
        filename,
        type: 'image',
        language: 'image',
        rawData: '',
        relativePath: path,
        imageBlob: blob,
      };
    }
    return null;
  }

  /**
   * テキストファイルを解析
   */
  private parseTextFile(content: string, filename: string, path: string): ParsedFileData {
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
        return {
          filename,
          type: 'proof',
          language,
          rawData: content,
          proofData,
          relativePath: path,
        };
      } else {
        // 証明ファイルではない通常のJSONファイル
        return {
          filename,
          type: 'plaintext',
          language: 'json',
          rawData: content,
          relativePath: path,
        };
      }
    } else {
      // JSON以外のファイル（C、TypeScript、Pythonなど）
      const language = getLanguageFromExtension(filename);
      return {
        filename,
        type: 'plaintext',
        language,
        rawData: content,
        relativePath: path,
      };
    }
  }

  /**
   * ZIP からスクリーンショットを読み込み
   */
  private async loadScreenshots(zip: JSZip): Promise<{
    screenshots: VerifyScreenshot[];
    screenshotService: ScreenshotService | undefined;
  }> {
    console.log('[ZipFileProcessor] Looking for screenshots/manifest.json in ZIP...');
    const manifestFile = zip.file('screenshots/manifest.json');
    if (!manifestFile) {
      console.log('[ZipFileProcessor] No manifest.json found in screenshots folder');
      return { screenshots: [], screenshotService: undefined };
    }

    try {
      const manifestText = await manifestFile.async('string');
      const parsed = JSON.parse(manifestText);

      // 新形式（オブジェクト with version/screenshots）と旧形式（配列）の両方に対応
      let manifest: ScreenshotManifest;
      if (Array.isArray(parsed)) {
        // 旧形式: 配列のみ
        console.log('[ZipFileProcessor] Legacy manifest format detected (array)');
        manifest = {
          version: '1.0',
          exportedAt: new Date().toISOString(),
          totalScreenshots: parsed.length,
          screenshots: parsed,
        };
      } else {
        // 新形式: オブジェクト
        manifest = parsed as ScreenshotManifest;
      }

      console.log('[ZipFileProcessor] Manifest loaded:', {
        version: manifest.version,
        totalScreenshots: manifest.totalScreenshots,
        screenshotsCount: manifest.screenshots?.length ?? 0,
      });

      if (!manifest.screenshots || manifest.screenshots.length === 0) {
        console.log('[ZipFileProcessor] Manifest has no screenshots');
        return { screenshots: [], screenshotService: undefined };
      }

      // スクリーンショットサービスを作成して読み込み
      const screenshotService = new ScreenshotService();
      const screenshots = await screenshotService.loadFromZip(zip, manifest);
      console.log('[ZipFileProcessor] Screenshots loaded:', screenshots.length);

      this.callbacks.onScreenshotLoad?.(
        screenshotService.count,
        screenshotService.verifiedCount
      );

      return { screenshots, screenshotService };
    } catch (error) {
      console.error('[ZipFileProcessor] Failed to load screenshots:', error);
      return { screenshots: [], screenshotService: undefined };
    }
  }

  /**
   * 最初のプルーフファイルからstartTimestampを計算
   */
  private calculateStartTimestamp(files: ParsedFileData[]): number | undefined {
    const firstProof = files.find((f) => f.proofData);
    if (!firstProof?.proofData) return undefined;

    const exportedAt = firstProof.proofData.metadata?.timestamp;
    const events = firstProof.proofData.proof?.events;
    if (exportedAt && events && events.length > 0) {
      const totalTime = events[events.length - 1]?.timestamp ?? 0;
      const exportTimestamp = new Date(exportedAt).getTime();
      return exportTimestamp - totalTime;
    }
    return undefined;
  }
}
