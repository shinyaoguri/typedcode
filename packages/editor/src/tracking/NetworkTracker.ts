/**
 * NetworkTracker - ネットワーク状態変更の追跡
 * オンライン/オフラインの変化を検出して記録
 */

import type { NetworkStatusData } from '@typedcode/shared';
import { t } from '../i18n/index.js';
import { BaseTracker } from './BaseTracker.js';

export interface NetworkTrackerEvent {
  type: 'networkStatusChange';
  data: NetworkStatusData;
  description: string;
}

export type NetworkTrackerCallback = (event: NetworkTrackerEvent, isInitial: boolean) => void;

export class NetworkTracker extends BaseTracker<NetworkTrackerEvent, NetworkTrackerCallback> {
  private boundHandleOnline: () => void;
  private boundHandleOffline: () => void;

  constructor() {
    super();
    this.boundHandleOnline = this.handleOnline.bind(this);
    this.boundHandleOffline = this.handleOffline.bind(this);
  }

  protected attachListeners(): void {
    window.addEventListener('online', this.boundHandleOnline);
    window.addEventListener('offline', this.boundHandleOffline);
  }

  protected detachListeners(): void {
    window.removeEventListener('online', this.boundHandleOnline);
    window.removeEventListener('offline', this.boundHandleOffline);
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

  private handleOnline(): void {
    this.callback?.({
      type: 'networkStatusChange',
      data: { online: true },
      description: t('events.networkOnline'),
    }, false);
  }

  private handleOffline(): void {
    this.callback?.({
      type: 'networkStatusChange',
      data: { online: false },
      description: t('events.networkOffline'),
    }, false);
  }
}
