/**
 * SingleInstanceGuard - 複数タブ/ウィンドウでの同時起動を防止するサービス
 *
 * すでにアプリが同じモードで起動中かどうかを検出し、後から開いた方をブロックする。
 * 判定は Web Locks (`navigator.locks`) の排他ロックで行う (#494)。ロックは持っているページが
 * 応答できない間 (同じ main thread を共有する popup の初期化中・凍結中) も持たれたままなので、
 * 判定が時間に依存しない。ページが破棄されればブラウザがロックを外す。
 * BroadcastChannel は heartbeat (instance-active。#237) と、Web Locks が無い環境での
 * ping → pong の判定 (500ms 待つ) のために残している。
 */

import { getSessionStorageService } from './SessionStorageService.js';

const CHANNEL_NAME_BASE = 'typedcode-instance-guard';
const HEARTBEAT_INTERVAL = 1000; // 1秒ごとにハートビート
const PING_TIMEOUT_MS = 500;

type MessageType =
  | { type: 'ping'; senderId: string }
  | { type: 'pong'; senderId: string }
  | { type: 'instance-active'; senderId: string };

/** Web Locks を使えるならその LockManager (node のテスト・古いブラウザでは無いことがある) */
function getLockManager(): LockManager | null {
  return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null;
}

export class SingleInstanceGuard {
  private channel: BroadcastChannel | null = null;
  private instanceId: string;
  private readonly channelName: string;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private isActive = false;
  /** 保持中のロックを解放する (ロックの callback が返した Promise を resolve する) */
  private releaseLock: (() => void) | null = null;

  /**
   * @param namespace モード等の名前空間。指定するとチャンネルとロックを分離し、別モードのタブ
   *   (例: /casual を開いた状態で /exam を別タブで開く) を「重複インスタンス」と誤判定しない。
   *   storage は既にモード別名前空間化されているので共存して問題ない。
   */
  constructor(namespace?: string) {
    // instanceId の権威は永続化される SessionStorageService 側 (生成箇所を 1 つに保つ)
    this.instanceId = getSessionStorageService().getInstanceId();
    // ロック名もチャンネル名と同じ `typedcode-instance-guard:<mode>`
    this.channelName = namespace ? `${CHANNEL_NAME_BASE}:${namespace}` : CHANNEL_NAME_BASE;
  }

  /**
   * 他のインスタンスが動作中かどうかをチェック
   * @returns true: 他のインスタンスが存在する（ブロックすべき）, false: このインスタンスが最初
   */
  async checkForExistingInstance(): Promise<boolean> {
    const locks = getLockManager();
    if (locks) {
      const acquired = await this.tryAcquireLock(locks);
      if (acquired === false) {
        console.log('[SingleInstanceGuard] Another instance holds the lock:', this.channelName);
        this.dispose();
        return true;
      }
      if (acquired === true) {
        if (typeof BroadcastChannel !== 'undefined') this.channel = new BroadcastChannel(this.channelName);
        this.becomeActive();
        return false;
      }
      // request 自体が失敗した (null) ときは ping → pong に戻る
    }
    return this.checkByPing();
  }

  /**
   * ロックを待たずに取りに行く (`ifAvailable`)。取れたら dispose まで持ち続ける。
   * @returns true: 取れた, false: 他のインスタンスが持っている, null: request が失敗した
   */
  private tryAcquireLock(locks: LockManager): Promise<boolean | null> {
    return new Promise((resolve) => {
      locks
        .request(this.channelName, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(false);
            return undefined;
          }
          // この Promise が settle するまでロックは保持される (dispose で resolve する)
          const held = new Promise<void>((release) => {
            this.releaseLock = release;
          });
          resolve(true);
          return held;
        })
        .catch((error: unknown) => {
          console.warn('[SingleInstanceGuard] Web Locks request failed, falling back to ping:', error);
          resolve(null);
        });
    });
  }

  /**
   * Web Locks が無い環境での判定: BroadcastChannel で ping を送り、既存インスタンスの pong を
   * 500ms 待つ。応答できない既存インスタンス (同じ main thread の popup の初期化中など) は
   * 見逃しうる (#494)。
   */
  private checkByPing(): Promise<boolean> {
    // BroadcastChannel がサポートされていない場合はチェックをスキップ
    if (typeof BroadcastChannel === 'undefined') {
      console.log('[SingleInstanceGuard] BroadcastChannel not supported, skipping check');
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      this.channel = new BroadcastChannel(this.channelName);

      let responded = false;
      // 起動レース対策: 2 タブがほぼ同時に起動すると、どちらもまだ becomeActive しておらず
      // pong を返さないため両方が active になり得る。チェック窓の間に届いた他インスタンスの
      // ping を検出し、instanceId の大小で決定的に片方だけ譲る (大きい id 側が譲る)。
      // Web Locks の経路ではロックの排他で片が付くので要らない。
      let yieldToCompetitor = false;

      const handleMessage = (event: MessageEvent<MessageType>) => {
        const message = event.data;
        if (message.senderId === this.instanceId) return;

        if (message.type === 'pong') {
          // 既に active な他インスタンスが応答した
          responded = true;
          console.log('[SingleInstanceGuard] Another instance responded:', message.senderId);
        } else if (message.type === 'ping') {
          // 同時起動中の競合。双方が相手の ping を見るので、id が大きい側だけが譲る。
          if (this.instanceId > message.senderId) {
            yieldToCompetitor = true;
            console.log('[SingleInstanceGuard] Yielding to concurrent instance:', message.senderId);
          }
        }
      };

      this.channel.addEventListener('message', handleMessage);

      // ping を送信して他のインスタンスの応答を待つ
      this.channel.postMessage({ type: 'ping', senderId: this.instanceId } as MessageType);

      // 一定時間待って応答を確認
      setTimeout(() => {
        this.channel?.removeEventListener('message', handleMessage);

        if (responded || yieldToCompetitor) {
          // 他のインスタンスが存在する / 競合に譲る - このインスタンスをブロック
          this.dispose();
          resolve(true);
        } else {
          // このインスタンスが最初 - アクティブとして登録
          this.becomeActive();
          resolve(false);
        }
      }, PING_TIMEOUT_MS);
    });
  }

  /**
   * このインスタンスをアクティブなインスタンスとして登録
   */
  private becomeActive(): void {
    this.isActive = true;
    console.log('[SingleInstanceGuard] This instance is now active:', this.instanceId);

    if (this.channel) {
      // 他のインスタンスからの ping に応答する (Web Locks の経路でも: ロックを使えない環境・
      // request が失敗した環境のインスタンスは ping → pong で判定する)
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
    }

    // ページ終了時にクリーンアップする。beforeunload では破棄しない (#483): 離脱確認 (記録のあるタブを
    // 閉じようとしたとき) で「このページに留まる」を選ぶとアンロードは起きないのに beforeunload は
    // 発火済みで、生きているページのガードだけが外れ、2 つ目のタブが正規インスタンスとして起動できて
    // しまう。pagehide は実際にページを離れるときだけ発火する。
    // persisted=true (bfcache に入る) ときは破棄しない: ページは凍結されるだけで、戻る操作で
    // そのまま復元される (pageshow で再取得しなくてもガードが生きている)。ロックも持ったまま入る。
    // Chromium では、bfcache 中のページが持つロックを別のページが求めると、そのページは bfcache から
    // 追い出され (WebLocksContention)、求めた側がロックを取る。戻る操作では読み直しになり、
    // 起動し直したガードが判定をやり直す (#494 で実測)。凍結中 (bfcache 以外) は ping に答えられないが、
    // ロックは持ち続けるので後から開いた側が止まる。凍結中の競合の扱いは #237 の範囲。
    window.addEventListener('pagehide', (event) => {
      if (!event.persisted) this.dispose();
    });
  }

  /**
   * リソースを解放
   */
  dispose(): void {
    if (this.releaseLock) {
      this.releaseLock();
      this.releaseLock = null;
    }

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
 * 未対応ブラウザ（Safari等）用のオーバーレイを表示
 */
export function showUnsupportedBrowserOverlay(): void {
  const overlay = document.getElementById('unsupported-browser-overlay');
  if (overlay) {
    overlay.classList.remove('hidden');
  }
}
