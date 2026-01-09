/**
 * ScreenshotStorageService - SessionStorageServiceへの委譲ラッパー
 * スクリーンショット画像のCRUD操作とエクスポート機能を提供
 *
 * 注: スクリーンショットはセッションDBに統合されています
 */

import type { StoredScreenshot } from '@typedcode/shared';
import type { SessionStorageService } from './SessionStorageService.js';

export class ScreenshotStorageService {
  private sessionService: SessionStorageService;
  private sessionId: string | null = null;

  constructor(sessionService: SessionStorageService) {
    this.sessionService = sessionService;
  }

  /**
   * セッションIDを設定
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
    console.log('[ScreenshotStorage] Session ID set:', sessionId);
  }

  /**
   * 現在のセッションIDを取得
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * 初期化（SessionStorageServiceは既に初期化済みのため何もしない）
   */
  async initialize(): Promise<void> {
    // SessionStorageServiceは既に初期化されているはず
    console.log('[ScreenshotStorage] Initialized (delegating to SessionStorageService)');
  }

  /**
   * スクリーンショットを保存
   * @returns 保存されたレコードのID
   */
  async save(screenshot: Omit<StoredScreenshot, 'id'>): Promise<string> {
    if (!this.sessionId) {
      throw new Error('Session ID not set');
    }

    const id = crypto.randomUUID();
    await this.sessionService.saveScreenshot({
      id,
      sessionId: this.sessionId,
      ...screenshot,
    });

    return id;
  }

  /**
   * IDでスクリーンショットを取得
   */
  async getById(id: string): Promise<StoredScreenshot | null> {
    const screenshot = await this.sessionService.getScreenshotById(id);
    return screenshot;
  }

  /**
   * 全スクリーンショットを取得（タイムスタンプ順）
   */
  async getAll(): Promise<StoredScreenshot[]> {
    if (!this.sessionId) {
      return [];
    }
    return this.sessionService.getScreenshotsBySession(this.sessionId);
  }

  /**
   * 特定のイベントシーケンス以降のスクリーンショットを取得
   */
  async getByEventSequenceRange(
    startSequence: number,
    endSequence?: number
  ): Promise<StoredScreenshot[]> {
    const all = await this.getAll();
    return all.filter(s => {
      if (s.eventSequence < startSequence) return false;
      if (endSequence !== undefined && s.eventSequence > endSequence) return false;
      return true;
    });
  }

  /**
   * スクリーンショットを削除
   */
  async delete(id: string): Promise<void> {
    await this.sessionService.deleteScreenshot(id);
  }

  /**
   * 全スクリーンショットを削除
   */
  async clear(): Promise<void> {
    if (!this.sessionId) {
      return;
    }
    await this.sessionService.clearScreenshotsBySession(this.sessionId);
  }

  /**
   * 古いスクリーンショットを削除（容量管理）
   * @param maxCount 保持する最大件数
   * @returns 削除された件数
   */
  async pruneOld(maxCount: number): Promise<number> {
    const all = await this.getAll();
    if (all.length <= maxCount) {
      return 0;
    }

    // タイムスタンプでソート（古い順）
    const sorted = all.sort((a, b) => a.timestamp - b.timestamp);
    const toDelete = sorted.slice(0, all.length - maxCount);

    for (const screenshot of toDelete) {
      await this.delete(screenshot.id);
    }

    console.log(`[ScreenshotStorage] Pruned ${toDelete.length} old screenshots`);
    return toDelete.length;
  }

  /**
   * スクリーンショット数を取得
   */
  async count(): Promise<number> {
    return this.sessionService.getScreenshotCount(this.sessionId ?? undefined);
  }

  /**
   * 全スクリーンショットをBlobとして取得（ZIPエクスポート用）
   * @returns ファイル名とBlobのマップ
   */
  async getAllForExport(): Promise<Map<string, Blob>> {
    const screenshots = await this.getAll();
    const result = new Map<string, Blob>();

    for (const screenshot of screenshots) {
      // ファイル名: screenshot_SEQUENCE_TIMESTAMP.jpg
      const timestamp = new Date(screenshot.createdAt).toISOString().replace(/[:.]/g, '-');
      const filename = `screenshot_${screenshot.eventSequence.toString().padStart(6, '0')}_${timestamp}.jpg`;
      result.set(filename, screenshot.imageBlob);
    }

    return result;
  }

  /**
   * エクスポート用のマニフェストを生成
   */
  async generateManifest(): Promise<object[]> {
    const screenshots = await this.getAll();

    return screenshots.map((screenshot, index) => {
      const timestamp = new Date(screenshot.createdAt).toISOString().replace(/[:.]/g, '-');
      const filename = `screenshot_${screenshot.eventSequence.toString().padStart(6, '0')}_${timestamp}.jpg`;

      return {
        index,
        filename,
        imageHash: screenshot.imageHash,
        captureType: screenshot.captureType,
        eventSequence: screenshot.eventSequence,
        timestamp: screenshot.timestamp,
        createdAt: screenshot.createdAt,
        displayInfo: screenshot.displayInfo,
        fileSizeBytes: screenshot.imageBlob.size,
      };
    });
  }

  /**
   * データベース接続を閉じる（何もしない - SessionStorageServiceが管理）
   */
  close(): void {
    // SessionStorageServiceが管理するため何もしない
    console.log('[ScreenshotStorage] Close called (no-op, managed by SessionStorageService)');
  }
}
