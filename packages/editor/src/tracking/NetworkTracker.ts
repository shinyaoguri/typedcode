/**
 * NetworkTracker - ネットワーク状態変更の追跡
 * オンライン/オフラインの変化を検出して記録
 */

import type { NetworkStatusData } from '@typedcode/shared';
import { t } from '../i18n/index.js';

export interface NetworkTrackerEvent {
  type: 'networkStatusChange';
  data: NetworkStatusData;
  description: string;
}

export type NetworkTrackerCallback = (event: NetworkTrackerEvent, isInitial: boolean) => void;

export class NetworkTracker {
  private callback: NetworkTrackerCallback | null = null;
  private boundHandleOnline: () => void;
  private boundHandleOffline: () => void;
  private attached = false;

  constructor() {
    this.boundHandleOnline = this.handleOnline.bind(this);
    this.boundHandleOffline = this.handleOffline.bind(this);
  }

  /**
   * コールバックを設定
   */
  setCallback(callback: NetworkTrackerCallback): void {
    this.callback = callback;
  }

  /**
   * ネットワークイベントリスナーをアタッチ
   */
  attach(): void {
    if (this.attached) return;
    window.addEventListener('online', this.boundHandleOnline);
    window.addEventListener('offline', this.boundHandleOffline);
    this.attached = true;
  }

  /**
   * ネットワークイベントリスナーをデタッチ
   */
  detach(): void {
    if (!this.attached) return;
    window.removeEventListener('online', this.boundHandleOnline);
    window.removeEventListener('offline', this.boundHandleOffline);
    this.attached = false;
  }

  /**
   * 初期ネットワーク状態を記録
   */
  recordInitial(): void {
    const online = navigator.onLine;

    this.callback?.({
      type: 'networkStatusChange',
      data: { online },
      description: t('events.initialNetworkState', { state: online ? t('events.online') : t('events.offline') }),
    }, true);
  }

  /**
   * オンラインイベントハンドラ
   */
  private handleOnline(): void {
    this.callback?.({
      type: 'networkStatusChange',
      data: { online: true },
      description: t('events.networkOnline'),
    }, false);
  }

  /**
   * オフラインイベントハンドラ
   */
  private handleOffline(): void {
    this.callback?.({
      type: 'networkStatusChange',
      data: { online: false },
      description: t('events.networkOffline'),
    }, false);
  }

  /**
   * リソースを解放
   */
  dispose(): void {
    this.detach();
    this.callback = null;
  }
}
