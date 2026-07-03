/**
 * ScreenshotService - スクリーンショット管理サービス
 *
 * ZIPからスクリーンショットを読み込み、ハッシュ検証、Object URL管理を行う
 */

import type JSZip from 'jszip';
import { checkScreenshotImage } from '@typedcode/shared';
import type {
  VerifyScreenshot,
  ScreenshotManifest,
  ScreenshotManifestEntry,
  ScreenshotVerificationSummary,
} from '../types.js';

/**
 * スクリーンショット管理サービス
 */
export class ScreenshotService {
  private screenshots: Map<string, VerifyScreenshot> = new Map();

  /**
   * ZIPファイルからスクリーンショットを読み込む
   * 画像ファイルが欠損している場合も、マニフェストエントリを保持（verified=false, missing=true）
   */
  async loadFromZip(
    zip: JSZip,
    manifest: ScreenshotManifest,
    /**
     * 検証済みチェーンが記録した screenshotCapture の imageHash 集合 (全 proof 横断)。
     * 与えると、manifest だけが指す (チェーンに無い) ハッシュを改ざんとして検出する。
     * manifest と画像は未署名なのでセットで差し替え可能 — 改ざん不能なチェーンが唯一の真正記録。
     */
    chainImageHashes?: ReadonlySet<string>
  ): Promise<VerifyScreenshot[]> {
    const screenshots: VerifyScreenshot[] = [];

    console.log('[ScreenshotService] Loading from ZIP, manifest entries:', manifest.screenshots.length);

    for (const entry of manifest.screenshots) {
      console.log('[ScreenshotService] Processing entry:', {
        index: entry.index,
        filename: entry.filename,
        timestamp: entry.timestamp,
      });
      const imagePath = `screenshots/${entry.filename}`;
      const imageFile = zip.file(imagePath);

      if (imageFile) {
        try {
          const blob = await imageFile.async('blob');

          // ハッシュ検証: 画像とハッシュが一致しても、そのハッシュがチェーンに無ければ
          // manifest+画像が揃って差し替えられた疑い (manifest は未署名・チェーンは改ざん不能)。
          // 判定は shared の単一実装 (#147: verify-cli と結論を揃える)。
          const { verified, tampered } = await checkScreenshotImage(
            await blob.arrayBuffer(),
            entry.imageHash,
            chainImageHashes
          );
          console.log(`[ScreenshotService] Image ${entry.filename}: verified=${verified}, tampered=${tampered}`);

          // ユニークIDとしてマニフェストのindexを使用（eventSequenceは重複の可能性あり）
          const screenshot: VerifyScreenshot = {
            id: `ss-${entry.index}`,
            filename: entry.filename,
            imageHash: entry.imageHash,
            captureType: entry.captureType,
            eventSequence: entry.eventSequence,
            timestamp: entry.timestamp,
            imageUrl: null, // 遅延読み込み
            imageBlob: blob,
            verified,
            missing: false,
            tampered,
            displayInfo: entry.displayInfo,
            fileSizeBytes: entry.fileSizeBytes,
          };

          this.screenshots.set(screenshot.id, screenshot);
          screenshots.push(screenshot);
        } catch (error) {
          // 画像読み込みエラー（破損など）の場合
          console.warn(`[ScreenshotService] Failed to load image ${entry.filename}:`, error);
          const screenshot = this.createMissingScreenshot(entry);
          this.screenshots.set(screenshot.id, screenshot);
          screenshots.push(screenshot);
        }
      } else {
        // 画像ファイルが欠損している場合もエントリを作成
        console.warn(`[ScreenshotService] Image file missing: ${entry.filename}`);
        const screenshot = this.createMissingScreenshot(entry);
        this.screenshots.set(screenshot.id, screenshot);
        screenshots.push(screenshot);
      }
    }

    console.log(
      '[ScreenshotService] Total loaded:',
      screenshots.length,
      'missing:',
      screenshots.filter((s) => s.missing).length
    );
    return screenshots;
  }

  /**
   * 欠損スクリーンショットエントリを作成
   */
  private createMissingScreenshot(entry: ScreenshotManifestEntry): VerifyScreenshot {
    return {
      id: `ss-${entry.index}`,
      filename: entry.filename,
      imageHash: entry.imageHash,
      captureType: entry.captureType,
      eventSequence: entry.eventSequence,
      timestamp: entry.timestamp,
      imageUrl: null,
      imageBlob: null,
      verified: false,
      missing: true, // 画像ファイルが欠損
      displayInfo: entry.displayInfo,
      fileSizeBytes: entry.fileSizeBytes,
    };
  }

  /**
   * File System Access APIを使用してフォルダからスクリーンショットを読み込む
   */
  async loadFromFolder(
    screenshotsFolderHandle: FileSystemDirectoryHandle,
    manifest: ScreenshotManifest,
    /** loadFromZip と同じ。検証済みチェーンが記録した imageHash 集合 (任意)。 */
    chainImageHashes?: ReadonlySet<string>
  ): Promise<VerifyScreenshot[]> {
    const screenshots: VerifyScreenshot[] = [];

    console.log('[ScreenshotService] Loading from folder, manifest entries:', manifest.screenshots.length);

    for (const entry of manifest.screenshots) {
      try {
        const fileHandle = await screenshotsFolderHandle.getFileHandle(entry.filename);
        const file = await fileHandle.getFile();
        const blob = new Blob([await file.arrayBuffer()], { type: file.type });

        // ハッシュ検証 (チェーン突合は loadFromZip と同じ。判定は shared の単一実装 #147)
        const { verified, tampered } = await checkScreenshotImage(
          await blob.arrayBuffer(),
          entry.imageHash,
          chainImageHashes
        );
        console.log(`[ScreenshotService] Image ${entry.filename}: verified=${verified}, tampered=${tampered}`);

        const screenshot: VerifyScreenshot = {
          id: `ss-${entry.index}`,
          filename: entry.filename,
          imageHash: entry.imageHash,
          captureType: entry.captureType,
          eventSequence: entry.eventSequence,
          timestamp: entry.timestamp,
          imageUrl: null,
          imageBlob: blob,
          verified,
          missing: false,
          tampered,
          displayInfo: entry.displayInfo,
          fileSizeBytes: entry.fileSizeBytes,
        };

        this.screenshots.set(screenshot.id, screenshot);
        screenshots.push(screenshot);
      } catch (error) {
        // 画像ファイルが見つからない場合
        console.warn(`[ScreenshotService] Image file missing: ${entry.filename}`);
        const screenshot = this.createMissingScreenshot(entry);
        this.screenshots.set(screenshot.id, screenshot);
        screenshots.push(screenshot);
      }
    }

    console.log(
      '[ScreenshotService] Total loaded from folder:',
      screenshots.length,
      'missing:',
      screenshots.filter((s) => s.missing).length
    );
    return screenshots;
  }

  /**
   * マニフェストエントリからスクリーンショット情報を作成（画像なし）
   */
  createFromManifestEntry(entry: ScreenshotManifestEntry): VerifyScreenshot {
    const screenshot: VerifyScreenshot = {
      id: `ss-${entry.index}`,
      filename: entry.filename,
      imageHash: entry.imageHash,
      captureType: entry.captureType,
      eventSequence: entry.eventSequence,
      timestamp: entry.timestamp,
      imageUrl: null,
      imageBlob: null,
      verified: false, // 画像がないので検証不可
      missing: true, // 画像なしで作成
      displayInfo: entry.displayInfo,
      fileSizeBytes: entry.fileSizeBytes,
    };

    this.screenshots.set(screenshot.id, screenshot);
    return screenshot;
  }

  /**
   * スクリーンショット一覧を取得
   */
  getScreenshots(): VerifyScreenshot[] {
    return Array.from(this.screenshots.values());
  }

  /**
   * IDでスクリーンショットを取得
   */
  getScreenshot(id: string): VerifyScreenshot | undefined {
    return this.screenshots.get(id);
  }

  /**
   * 画像URLを取得（遅延読み込み）
   */
  getImageUrl(id: string): string | null {
    const screenshot = this.screenshots.get(id);
    if (!screenshot || !screenshot.imageBlob) return null;

    if (!screenshot.imageUrl) {
      screenshot.imageUrl = URL.createObjectURL(screenshot.imageBlob);
    }

    return screenshot.imageUrl;
  }

  /**
   * 全スクリーンショットの画像URLを生成
   */
  generateAllImageUrls(): void {
    for (const screenshot of this.screenshots.values()) {
      if (screenshot.imageBlob && !screenshot.imageUrl) {
        screenshot.imageUrl = URL.createObjectURL(screenshot.imageBlob);
      }
    }
  }

  /**
   * タイムスタンプで最も近いスクリーンショットを取得
   */
  findNearestScreenshot(timestamp: number): VerifyScreenshot | null {
    let nearest: VerifyScreenshot | null = null;
    let minDiff = Infinity;

    for (const screenshot of this.screenshots.values()) {
      const diff = Math.abs(screenshot.timestamp - timestamp);
      if (diff < minDiff) {
        minDiff = diff;
        nearest = screenshot;
      }
    }

    return nearest;
  }

  /**
   * 指定時間範囲のスクリーンショットを取得
   */
  getScreenshotsInRange(startTime: number, endTime: number): VerifyScreenshot[] {
    return Array.from(this.screenshots.values()).filter((s) => s.timestamp >= startTime && s.timestamp <= endTime);
  }

  /**
   * スクリーンショット数を取得
   */
  get count(): number {
    return this.screenshots.size;
  }

  /**
   * 検証済みスクリーンショット数を取得
   */
  get verifiedCount(): number {
    return Array.from(this.screenshots.values()).filter((s) => s.verified).length;
  }

  /**
   * 欠損スクリーンショット数を取得
   */
  get missingCount(): number {
    return Array.from(this.screenshots.values()).filter((s) => s.missing).length;
  }

  /**
   * 改竄されたスクリーンショット数を取得
   */
  get tamperedCount(): number {
    return Array.from(this.screenshots.values()).filter((s) => s.tampered).length;
  }

  /**
   * 検証サマリーを取得
   */
  getVerificationSummary(): ScreenshotVerificationSummary {
    const screenshots = Array.from(this.screenshots.values());
    return {
      total: screenshots.length,
      verified: screenshots.filter((s) => s.verified && !s.missing && !s.tampered).length,
      missing: screenshots.filter((s) => s.missing).length,
      tampered: screenshots.filter((s) => s.tampered).length,
    };
  }

  /**
   * クリーンアップ（Object URLを解放）
   */
  dispose(): void {
    for (const screenshot of this.screenshots.values()) {
      if (screenshot.imageUrl) {
        URL.revokeObjectURL(screenshot.imageUrl);
        screenshot.imageUrl = null;
      }
    }
    this.screenshots.clear();
  }

  /**
   * 単一のスクリーンショットをクリア
   */
  clearScreenshot(id: string): void {
    const screenshot = this.screenshots.get(id);
    if (screenshot?.imageUrl) {
      URL.revokeObjectURL(screenshot.imageUrl);
    }
    this.screenshots.delete(id);
  }
}
