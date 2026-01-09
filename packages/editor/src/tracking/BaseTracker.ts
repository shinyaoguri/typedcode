/**
 * BaseTracker - トラッカーの抽象基底クラス
 *
 * 全トラッカーに共通するattach/detach/disposeパターンを提供
 */

/**
 * トラッカーの基底クラス
 *
 * @template TEvent イベントの型
 * @template TCallback コールバックの型（デフォルトは単一イベントを受け取る関数）
 */
export abstract class BaseTracker<TEvent, TCallback = (event: TEvent) => void | Promise<void>> {
  protected callback: TCallback | null = null;
  protected attached = false;

  /**
   * コールバックを設定
   */
  setCallback(callback: TCallback): void {
    this.callback = callback;
  }

  /**
   * イベントリスナーをアタッチ
   */
  attach(): void {
    if (this.attached) return;
    this.attachListeners();
    this.attached = true;
  }

  /**
   * イベントリスナーをデタッチ
   */
  detach(): void {
    if (!this.attached) return;
    this.detachListeners();
    this.attached = false;
  }

  /**
   * リソースを解放
   */
  dispose(): void {
    this.detach();
    this.callback = null;
  }

  /**
   * アタッチされているかどうか
   */
  isAttached(): boolean {
    return this.attached;
  }

  /**
   * イベントリスナーをアタッチする（サブクラスで実装）
   */
  protected abstract attachListeners(): void;

  /**
   * イベントリスナーをデタッチする（サブクラスで実装）
   */
  protected abstract detachListeners(): void;

  /**
   * イベントを発行（コールバックが設定されていれば呼び出す）
   */
  protected emit(event: TEvent): void | Promise<void> {
    if (this.callback && typeof this.callback === 'function') {
      return (this.callback as (event: TEvent) => void | Promise<void>)(event);
    }
  }
}
