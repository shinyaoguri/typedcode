/**
 * IdleTimeoutManager - 連続使用制限管理
 *
 * フォーカス喪失から一定時間経過後に警告ダイアログを表示し、
 * 応答がなければ記録を一時停止する。
 */

export type IdleState = 'active' | 'warning' | 'suspended';

export interface IdleTimeoutManagerOptions {
  /** フォーカス喪失後の待機時間（ミリ秒） デフォルト: 1時間 */
  idleTimeoutMs?: number;
  /** ダイアログ応答待ち時間（ミリ秒） デフォルト: 5分 */
  warningTimeoutMs?: number;
}

export interface IdleTimeoutCallbacks {
  /** 記録一時停止時のコールバック */
  onSuspend: () => void;
  /** 記録再開時のコールバック */
  onResume: () => void;
  /** 状態変更時のコールバック */
  onStateChange?: (state: IdleState) => void;
}

export interface IdleTimeoutUICallbacks {
  /** 警告ダイアログを表示（継続=true, タイムアウト/キャンセル=false） */
  showWarningDialog: () => Promise<boolean>;
  /** 記録停止オーバーレイを表示 */
  showSuspendedOverlay: () => void;
  /** 記録停止オーバーレイを非表示 */
  hideSuspendedOverlay: () => void;
}

export class IdleTimeoutManager {
  // 定数
  private static readonly DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1時間

  // 状態
  private state: IdleState = 'active';
  private isShowingDialog = false;

  // タイマー
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  // 設定
  private readonly idleTimeoutMs: number;

  // コールバック
  private callbacks: IdleTimeoutCallbacks | null = null;
  private uiCallbacks: IdleTimeoutUICallbacks | null = null;

  // タイトル点滅
  private originalTitle: string = '';
  private titleFlashInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options?: IdleTimeoutManagerOptions) {
    this.idleTimeoutMs =
      options?.idleTimeoutMs ?? IdleTimeoutManager.DEFAULT_IDLE_TIMEOUT_MS;
    // warningTimeoutMs はダイアログ側で直接管理するため、ここでは使用しない
  }

  /**
   * 記録制御コールバックを設定
   */
  setCallbacks(callbacks: IdleTimeoutCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * UIコールバックを設定
   */
  setUICallbacks(uiCallbacks: IdleTimeoutUICallbacks): void {
    this.uiCallbacks = uiCallbacks;
  }

  /**
   * フォーカス喪失時に呼び出す
   */
  handleFocusLost(): void {
    // suspended中は無視
    if (this.state === 'suspended') return;

    // warning中（ダイアログ表示中）は新たなタイマーを開始しない
    if (this.state === 'warning') return;

    this.startIdleTimer();
    console.log(
      `[IdleTimeoutManager] Focus lost, starting ${this.idleTimeoutMs / 1000 / 60}min idle timer`
    );
  }

  /**
   * フォーカス復帰時に呼び出す
   */
  handleFocusRegained(): void {
    // suspended状態ではフォーカス復帰でも自動復帰しない
    if (this.state === 'suspended') {
      console.log('[IdleTimeoutManager] Focus regained in suspended state (manual resume required)');
      return;
    }

    // warning中にフォーカス復帰 -> ダイアログは継続表示、タイマーはリセット
    if (this.state === 'warning') {
      console.log('[IdleTimeoutManager] Focus regained during warning');
      return;
    }

    // active状態 -> タイマーをクリア
    this.clearIdleTimer();
    console.log('[IdleTimeoutManager] Focus regained, idle timer cleared');
  }

  /**
   * 現在の状態を取得
   */
  getState(): IdleState {
    return this.state;
  }

  /**
   * suspended状態から復帰（再開ボタン押下時）
   */
  resume(): void {
    if (this.state !== 'suspended') return;

    this.uiCallbacks?.hideSuspendedOverlay();
    this.transitionTo('active');
    this.callbacks?.onResume();
    console.log('[IdleTimeoutManager] Resumed from suspended state');
  }

  /**
   * リソース解放
   */
  dispose(): void {
    this.clearIdleTimer();
    this.stopTitleFlash();
    this.callbacks = null;
    this.uiCallbacks = null;
  }

  // ==================== 内部メソッド ====================

  private startIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.onIdleTimeout();
    }, this.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private transitionTo(newState: IdleState): void {
    if (this.state === newState) return;

    const oldState = this.state;
    this.state = newState;
    this.callbacks?.onStateChange?.(newState);
    console.log(`[IdleTimeoutManager] State: ${oldState} -> ${newState}`);
  }

  private async onIdleTimeout(): Promise<void> {
    // 既にダイアログ表示中なら何もしない
    if (this.isShowingDialog) return;

    this.transitionTo('warning');
    this.isShowingDialog = true;

    // ウィンドウにフォーカスを試みる（ブラウザ制限あり）
    try {
      window.focus();
    } catch {
      // 無視
    }

    // タイトル点滅開始
    this.startTitleFlash();

    // 警告ダイアログを表示（5分タイムアウト付き）
    const continued = (await this.uiCallbacks?.showWarningDialog()) ?? false;

    this.isShowingDialog = false;
    this.stopTitleFlash();

    if (continued) {
      // 継続を選択 -> active に戻る
      this.transitionTo('active');

      // フォーカスがない場合は再度タイマー開始
      if (!document.hasFocus()) {
        this.startIdleTimer();
      }
    } else {
      // タイムアウトまたはキャンセル -> suspended
      this.suspend();
    }
  }

  private suspend(): void {
    this.clearIdleTimer();
    this.stopTitleFlash();
    this.transitionTo('suspended');
    this.uiCallbacks?.showSuspendedOverlay();
    this.callbacks?.onSuspend();
    console.log('[IdleTimeoutManager] Recording suspended due to idle timeout');
  }

  /**
   * タブタイトル点滅（注意を引くため）
   */
  private startTitleFlash(): void {
    this.stopTitleFlash();
    this.originalTitle = document.title;
    let isOriginal = true;

    this.titleFlashInterval = setInterval(() => {
      document.title = isOriginal ? '⚠️ 確認が必要です' : this.originalTitle;
      isOriginal = !isOriginal;
    }, 1000);
  }

  private stopTitleFlash(): void {
    if (this.titleFlashInterval) {
      clearInterval(this.titleFlashInterval);
      this.titleFlashInterval = null;
      document.title = this.originalTitle;
    }
  }
}
