/**
 * FullscreenTracker - 試験モードのフルスクリーン要求・記録・警告バナー (ADR-0008)
 *
 * exam モードは fullscreen を **要求するが強制しない**。非フルスクリーンでも全機能を使えるが、
 * その間は常時警告バナーを出し、ボタンでフルスクリーンに復帰できる。フルスクリーン状態
 * (grant/deny・enter/exit・unavailable) は `fullscreenChange` イベントとしてチェーンに記録する。
 *
 * requestFullscreen() はユーザー操作 (transient activation) を要するため、警告バナーの
 * 「フルスクリーンで受験」ボタンが開始ジェスチャを兼ねる (ADR-0008「開始ボタンに紐付け」)。
 *
 * macOS の注意: ネイティブ全画面 (緑ボタン / メニューバーの全画面解除) は HTML Fullscreen API の
 * `fullscreenchange` を発火せず `document.fullscreenElement` が残留することがある。そのため
 * (1) `(display-mode: fullscreen)` メディアクエリ (2) `resize` も併せて監視し、(3) 残留時は実寸で
 * 全画面かを確認する、という多重検出で「全画面を抜けたのにバナーが出ない」を防ぐ。
 */

import type { FullscreenChangeData, RecordEventInput } from '@typedcode/shared';
import { t } from '../i18n/index.js';

export type FullscreenRecordCallback = (event: RecordEventInput) => void;

export class FullscreenTracker {
  private record: FullscreenRecordCallback | null = null;
  private banner: HTMLElement | null = null;
  private enterBtn: HTMLElement | null = null;
  private displayModeMql: MediaQueryList | null = null;
  /** requestFullscreen() 起因の遷移を 'request' として区別するためのフラグ。 */
  private pendingRequest = false;
  /** 直近に確定した実効フルスクリーン状態 (二重記録の抑止に使う)。 */
  private currentFs = false;
  private boundOnChange: () => void;
  private boundOnClick: () => void;

  constructor() {
    this.boundOnChange = this.handleStateChange.bind(this);
    this.boundOnClick = () => {
      void this.requestFullscreen();
    };
  }

  setRecordCallback(cb: FullscreenRecordCallback): void {
    this.record = cb;
  }

  /**
   * DOM 捕捉 + リスナ配線 + 初期状態記録。fullscreen を記録するモードの開始時に呼ぶ。
   *
   * @param showBanner exam は警告バナー + 要求ボタンを出す (true)。class は**受動記録のみ**で
   *   バナー/ボタンの DOM を取得しない (false, ADR-0014)。状態記録 (`fullscreenChange`) は両者共通。
   */
  initialize(showBanner = true): void {
    if (showBanner) {
      this.banner = document.getElementById('fullscreen-warning-banner');
      this.enterBtn = document.getElementById('enter-fullscreen-btn');
      this.enterBtn?.addEventListener('click', this.boundOnClick);
    }

    // (1) HTML Fullscreen API。(2) ネイティブ全画面も拾う表示モード変化。(3) 取りこぼし対策の resize。
    document.addEventListener('fullscreenchange', this.boundOnChange);
    this.displayModeMql = window.matchMedia('(display-mode: fullscreen)');
    this.displayModeMql.addEventListener('change', this.boundOnChange);
    window.addEventListener('resize', this.boundOnChange);

    this.currentFs = this.isFullscreen();
    this.emit('initial', null, this.currentFs);
    this.updateBanner();
  }

  /** ユーザー操作からフルスクリーンを要求する (バナーのボタン)。 */
  async requestFullscreen(): Promise<void> {
    if (!this.isAvailable()) {
      this.emit('request', false, false);
      return;
    }
    if (this.isFullscreen()) return;
    this.pendingRequest = true;
    try {
      await document.documentElement.requestFullscreen();
      // 成功時は状態変化ハンドラ側で reason='request' granted=true を記録する。
    } catch {
      this.pendingRequest = false;
      this.emit('request', false, false); // 拒否 / 失敗
      this.updateBanner();
    }
  }

  dispose(): void {
    document.removeEventListener('fullscreenchange', this.boundOnChange);
    this.displayModeMql?.removeEventListener('change', this.boundOnChange);
    window.removeEventListener('resize', this.boundOnChange);
    this.enterBtn?.removeEventListener('click', this.boundOnClick);
  }

  private isAvailable(): boolean {
    return document.fullscreenEnabled;
  }

  /**
   * 実効フルスクリーン判定。HTML API / 表示モード / 実寸を組み合わせ、macOS の
   * `fullscreenElement` 残留にも耐える。
   */
  private isFullscreen(): boolean {
    if (this.displayModeMql?.matches) return true;
    if (document.fullscreenElement !== null) {
      // fullscreenElement が残留しても、実寸が全画面でなければ「抜けた」とみなす。
      return this.looksFullscreenBySize();
    }
    return false;
  }

  /** ウィンドウが画面全体を覆っているか (CSS px 同士の比較なので DPR の影響は受けない)。 */
  private looksFullscreenBySize(): boolean {
    return (
      window.innerWidth >= screen.width - 2 && window.innerHeight >= screen.height - 2
    );
  }

  private handleStateChange(): void {
    const fs = this.isFullscreen();
    if (fs !== this.currentFs) {
      this.currentFs = fs;
      if (this.pendingRequest) {
        this.pendingRequest = false;
        this.emit('request', fs, fs);
      } else {
        this.emit('change', null, fs);
      }
    }
    this.updateBanner();
  }

  /** 非フルスクリーン中はバナーを表示、フルスクリーン中は隠す。 */
  private updateBanner(): void {
    this.banner?.classList.toggle('visible', !this.currentFs);
  }

  private emit(
    reason: FullscreenChangeData['reason'],
    requestGranted: boolean | null,
    fullscreen: boolean
  ): void {
    const data: FullscreenChangeData = {
      fullscreen,
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
