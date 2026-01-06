/**
 * SingleInstanceGuard - 複数タブ/ウィンドウでの同時起動を防止するサービス
 *
 * BroadcastChannel API を使用して、すでにアプリが別のタブで起動中かどうかを検出し、
 * 後から開いた方をブロックする。
 */

const CHANNEL_NAME = 'typedcode-instance-guard';
const HEARTBEAT_INTERVAL = 1000; // 1秒ごとにハートビート
const HEARTBEAT_TIMEOUT = 3000; // 3秒応答がなければタイムアウト

type MessageType =
  | { type: 'ping'; senderId: string }
  | { type: 'pong'; senderId: string }
  | { type: 'instance-active'; senderId: string };

export class SingleInstanceGuard {
  private channel: BroadcastChannel | null = null;
  private instanceId: string;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private isActive = false;

  constructor() {
    this.instanceId = crypto.randomUUID();
  }

  /**
   * 他のインスタンスが動作中かどうかをチェック
   * @returns true: 他のインスタンスが存在する（ブロックすべき）, false: このインスタンスが最初
   */
  async checkForExistingInstance(): Promise<boolean> {
    // BroadcastChannel がサポートされていない場合はチェックをスキップ
    if (typeof BroadcastChannel === 'undefined') {
      console.log('[SingleInstanceGuard] BroadcastChannel not supported, skipping check');
      return false;
    }

    return new Promise((resolve) => {
      this.channel = new BroadcastChannel(CHANNEL_NAME);

      let responded = false;

      const handleMessage = (event: MessageEvent<MessageType>) => {
        const message = event.data;

        if (message.type === 'pong' && message.senderId !== this.instanceId) {
          // 他のインスタンスが応答した
          responded = true;
          console.log('[SingleInstanceGuard] Another instance responded:', message.senderId);
        }
      };

      this.channel.addEventListener('message', handleMessage);

      // ping を送信して他のインスタンスの応答を待つ
      this.channel.postMessage({ type: 'ping', senderId: this.instanceId } as MessageType);

      // 一定時間待って応答を確認
      setTimeout(() => {
        this.channel?.removeEventListener('message', handleMessage);

        if (responded) {
          // 他のインスタンスが存在する - このインスタンスをブロック
          this.dispose();
          resolve(true);
        } else {
          // このインスタンスが最初 - アクティブとして登録
          this.becomeActive();
          resolve(false);
        }
      }, 500); // 500ms 待機
    });
  }

  /**
   * このインスタンスをアクティブなインスタンスとして登録
   */
  private becomeActive(): void {
    if (!this.channel) return;

    this.isActive = true;
    console.log('[SingleInstanceGuard] This instance is now active:', this.instanceId);

    // 他のインスタンスからの ping に応答
    this.channel.addEventListener('message', (event: MessageEvent<MessageType>) => {
      const message = event.data;

      if (message.type === 'ping' && message.senderId !== this.instanceId) {
        console.log('[SingleInstanceGuard] Received ping from:', message.senderId);
        this.channel?.postMessage({ type: 'pong', senderId: this.instanceId } as MessageType);
      }
    });

    // 定期的にハートビートを送信（このインスタンスがまだ生きていることを通知）
    this.heartbeatTimer = setInterval(() => {
      this.channel?.postMessage({ type: 'instance-active', senderId: this.instanceId } as MessageType);
    }, HEARTBEAT_INTERVAL);

    // ページ終了時にクリーンアップ
    window.addEventListener('beforeunload', () => {
      this.dispose();
    });
  }

  /**
   * リソースを解放
   */
  dispose(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }

    this.isActive = false;
  }

  /**
   * このインスタンスがアクティブかどうか
   */
  getIsActive(): boolean {
    return this.isActive;
  }
}

/**
 * 重複インスタンスブロック用のオーバーレイを表示
 */
export function showDuplicateInstanceOverlay(): void {
  const overlay = document.getElementById('duplicate-instance-overlay');
  if (overlay) {
    overlay.classList.remove('hidden');
  }
}

/**
 * 重複インスタンスブロック用のオーバーレイを非表示
 */
export function hideDuplicateInstanceOverlay(): void {
  const overlay = document.getElementById('duplicate-instance-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
  }
}

/**
 * 未対応ブラウザ（Safari等）用のオーバーレイを表示
 */
export function showUnsupportedBrowserOverlay(): void {
  const overlay = document.getElementById('unsupported-browser-overlay');
  if (overlay) {
    overlay.classList.remove('hidden');
  }
}
