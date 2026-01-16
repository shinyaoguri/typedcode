/**
 * ScreenshotTrackerState - スクリーンショットトラッカーの状態管理
 *
 * ScreenshotTrackerの状態を一元管理し、状態の可視性を向上
 */

import type { DisplayInfo } from '@typedcode/shared';

export class ScreenshotTrackerState {
  /** イベントリスナーがアタッチされているか */
  attached = false;

  /** 初期化済みか（セッション開始済みか） */
  initialized = false;

  /** キャプチャ保存が有効か（タブがない場合は無効） */
  captureEnabled = true;

  /** 画面共有をオプトアウトしたか */
  optedOut = false;

  /** 最後に記録されたイベントのシーケンス番号 */
  lastEventSequence = 0;

  /** TypingProofの開始時刻（相対時間計算用） */
  proofStartTime = 0;

  /** 画面共有開始時刻 */
  shareStartTimestamp: number | null = null;

  /** 現在のディスプレイ情報 */
  currentDisplayInfo: DisplayInfo | null = null;

  /** 現在のディスプレイサーフェス種別 */
  currentDisplaySurface: string | null = null;

  /**
   * 画面共有開始時の状態を設定
   */
  setShareStarted(displaySurface: string, displayInfo: DisplayInfo): void {
    this.shareStartTimestamp = performance.now();
    this.currentDisplaySurface = displaySurface;
    this.currentDisplayInfo = displayInfo;
    this.attached = true;
    this.initialized = true;
  }

  /**
   * 画面共有停止時の状態をリセット
   */
  resetShareState(): void {
    this.shareStartTimestamp = null;
    this.attached = false;
  }

  /**
   * 全状態をリセット
   */
  reset(): void {
    this.attached = false;
    this.initialized = false;
    this.captureEnabled = true;
    this.optedOut = false;
    this.lastEventSequence = 0;
    this.proofStartTime = 0;
    this.shareStartTimestamp = null;
    this.currentDisplayInfo = null;
    this.currentDisplaySurface = null;
  }

  /**
   * 共有中の経過時間を取得
   */
  getShareDuration(): number {
    if (this.shareStartTimestamp === null) return 0;
    return performance.now() - this.shareStartTimestamp;
  }

  /**
   * 相対タイムスタンプを取得
   */
  getRelativeTimestamp(): number {
    return performance.now() - this.proofStartTime;
  }

  /**
   * 共有開始からの相対タイムスタンプを取得
   */
  getShareStartRelativeTimestamp(): number {
    if (this.shareStartTimestamp === null) {
      return this.getRelativeTimestamp();
    }
    return this.shareStartTimestamp - this.proofStartTime;
  }
}
