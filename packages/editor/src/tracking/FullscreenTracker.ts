/**
 * FullscreenTracker - 試験モードのフルスクリーン要求・記録・警告バナー (ADR-0008)
 *
 * exam モードは fullscreen を **要求するが強制しない**。非フルスクリーンでも全機能を使えるが、
 * その間は常時警告バナーを出し、ボタンでフルスクリーンに復帰できる。フルスクリーン状態
 * (grant/deny・enter/exit・unavailable) は `fullscreenChange` イベントとしてチェーンに記録する。
 *
 * requestFullscreen() はユーザー操作 (transient activation) を要するため、警告バナーの
 * 「フルスクリーンで受験」ボタンが開始ジェスチャを兼ねる (ADR-0008「開始ボタンに紐付け」)。
 */

import type { FullscreenChangeData, RecordEventInput } from '@typedcode/shared';
import { t } from '../i18n/index.js';

export type FullscreenRecordCallback = (event: RecordEventInput) => void;

export class FullscreenTracker {
  private record: FullscreenRecordCallback | null = null;
  private banner: HTMLElement | null = null;
  private enterBtn: HTMLElement | null = null;
  /** requestFullscreen() 起因の fullscreenchange を 'request' として区別するためのフラグ。 */
  private pendingRequest = false;
  private boundOnChange: () => void;
  private boundOnClick: () => void;

  constructor() {
    this.boundOnChange = this.onFullscreenChange.bind(this);
    this.boundOnClick = () => {
      void this.requestFullscreen();
    };
  }

  setRecordCallback(cb: FullscreenRecordCallback): void {
    this.record = cb;
  }

  /** DOM 捕捉 + リスナ配線 + 初期状態記録。試験モード開始時に呼ぶ。 */
  initialize(): void {
    this.banner = document.getElementById('fullscreen-warning-banner');
    this.enterBtn = document.getElementById('enter-fullscreen-btn');
    this.enterBtn?.addEventListener('click', this.boundOnClick);
    document.addEventListener('fullscreenchange', this.boundOnChange);
    this.recordInitial();
    this.updateBanner();
  }

  /** 開始時プローブ (現在状態と可用性を記録)。 */
  recordInitial(): void {
    this.emit('initial', null);
  }

  /** ユーザー操作からフルスクリーンを要求する (バナーのボタン)。 */
  async requestFullscreen(): Promise<void> {
    if (!this.isAvailable()) {
      this.emit('request', false);
      return;
    }
    if (this.isFullscreen()) return;
    this.pendingRequest = true;
    try {
      await document.documentElement.requestFullscreen();
      // 成功時は fullscreenchange が発火し、そこで reason='request' granted=true を記録する。
    } catch {
      this.pendingRequest = false;
      this.emit('request', false); // 拒否 / 失敗
      this.updateBanner();
    }
  }

  dispose(): void {
    document.removeEventListener('fullscreenchange', this.boundOnChange);
    this.enterBtn?.removeEventListener('click', this.boundOnClick);
  }

  private isFullscreen(): boolean {
    return document.fullscreenElement !== null;
  }

  private isAvailable(): boolean {
    return document.fullscreenEnabled;
  }

  private onFullscreenChange(): void {
    if (this.pendingRequest) {
      this.pendingRequest = false;
      this.emit('request', this.isFullscreen());
    } else {
      this.emit('change', null);
    }
    this.updateBanner();
  }

  /** 非フルスクリーン中はバナーを表示、フルスクリーン中は隠す。 */
  private updateBanner(): void {
    if (!this.banner) return;
    if (this.isFullscreen()) {
      this.banner.classList.remove('visible');
    } else {
      this.banner.classList.add('visible');
    }
  }

  private emit(reason: FullscreenChangeData['reason'], requestGranted: boolean | null): void {
    const denied = reason === 'request' && requestGranted === false;
    const data: FullscreenChangeData = {
      fullscreen: denied ? false : this.isFullscreen(),
      available: this.isAvailable(),
      reason,
      requestGranted,
    };
    this.record?.({
      type: 'fullscreenChange',
      data,
      description: this.describe(data),
    });
  }

  private describe(d: FullscreenChangeData): string {
    if (!d.available) return t('exam.fsUnavailable');
    if (d.reason === 'request' && d.requestGranted === false) return t('exam.fsDenied');
    return d.fullscreen ? t('exam.fsEntered') : t('exam.fsExited');
  }
}
