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
  protected enabled = true;

  /**
   * コールバックを設定
   */
  setCallback(callback: TCallback): void {
    this.callback = callback;
  }

  /**
   * 有効/無効を設定
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * 有効かどうか
   */
  isEnabled(): boolean {
    return this.enabled;
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

/**
 * 特定のHTML要素にアタッチするトラッカーの基底クラス
 */
export abstract class ElementTracker<TEvent, TCallback = (event: TEvent) => void | Promise<void>> extends BaseTracker<TEvent, TCallback> {
  protected element: HTMLElement | null = null;

  /**
   * 指定した要素にイベントリスナーをアタッチ
   */
  attachTo(element: HTMLElement): void {
    if (this.attached) {
      this.detach();
    }
    this.element = element;
    this.attach();
  }

  /**
   * リソースを解放
   */
  override dispose(): void {
    super.dispose();
    this.element = null;
  }

  /**
   * 状態をリセット（サブクラスでオーバーライド可能）
   */
  reset(): void {
    // デフォルトは何もしない
  }
}
