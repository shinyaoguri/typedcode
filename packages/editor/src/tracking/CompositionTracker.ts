/**
 * CompositionTracker - Monaco の composition イベントを `compositionCorrelation` の状態に写す薄いアダプタ (#720)
 *
 * 情報源は Monaco の公開 API `onDidCompositionStart` / `onDidCompositionEnd` だけ:
 *  - DOM の compositionstart / beforeinput は使わない。Monaco 0.57 は Chromium で native EditContext を
 *    既定で使い、IME のイベントは DOM 要素でなく EditContext オブジェクトに飛ぶので届かない (実測)
 *  - `editor.inComposition` は読まない。確定の編集より先に false になる環境がある。状態は start / end の
 *    イベントで自前に持つ
 *
 * 範囲: 主カーソルの 1 領域だけを追う。複数カーソルの composition の残りのカーソルの編集は `none`
 * (従来の分類) になる。attach した時点で composition 中でも idle から始める (start を見ていない
 * composition には帰属させない)。
 */

import type * as monaco from 'monaco-editor';
import type { ModelContentChange, ModelContentChangedEvent } from '../editor/types.js';
import {
  type CompositionAttribution,
  type CompositionState,
  IDLE_COMPOSITION,
  correlateChange,
  endComposition,
  settleComposition,
  startComposition,
} from './compositionCorrelation.js';

/** settling を閉じる処理を次のタスクへ回す関数。既定は `setTimeout(0)`。テストでは注入する。 */
export type SettleScheduler = (callback: () => void) => void;

export interface CompositionTrackerOptions {
  scheduleSettle?: SettleScheduler;
}

const defaultScheduleSettle: SettleScheduler = (callback) => {
  setTimeout(callback, 0);
};

export class CompositionTracker {
  private state: CompositionState = IDLE_COMPOSITION;
  private editor: monaco.editor.ICodeEditor | null = null;
  private disposables: monaco.IDisposable[] = [];
  /** settling を閉じる予約が古くなったかを見分ける世代。start / reset / 新しい end で進める。 */
  private generation = 0;
  private readonly scheduleSettle: SettleScheduler;

  constructor(options: CompositionTrackerOptions = {}) {
    this.scheduleSettle = options.scheduleSettle ?? defaultScheduleSettle;
  }

  attach(editor: monaco.editor.ICodeEditor): void {
    if (this.editor) return;
    this.editor = editor;
    this.disposables.push(
      editor.onDidCompositionStart(() => this.handleStart()),
      editor.onDidCompositionEnd(() => this.handleEnd()),
      editor.onDidChangeModel(() => this.reset()),
      editor.onDidBlurEditorText(() => this.reset())
    );
  }

  detach(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
    this.editor = null;
    this.reset();
  }

  /**
   * contentChange 1 件の帰属を返し、状態を進める。`onDidChangeModelContent` の中で、記録と同じ
   * `event.changes` の順に同期で呼ぶ。flush (setValue など、モデルの全置換) は composition を打ち切る。
   */
  attribute(change: ModelContentChange, event: ModelContentChangedEvent): CompositionAttribution {
    if (event.isFlush) {
      this.reset();
      return 'none';
    }
    const model = this.editor?.getModel();
    if (!model) return 'none';

    const result = correlateChange(this.state, model.id, change);
    this.state = result.state;
    return result.attribution;
  }

  private handleStart(): void {
    this.generation++;
    const model = this.editor?.getModel();
    const selection = this.editor?.getSelection();
    if (!model || !selection) {
      this.state = IDLE_COMPOSITION;
      return;
    }
    this.state = startComposition(model.id, {
      start: model.getOffsetAt(selection.getStartPosition()),
      end: model.getOffsetAt(selection.getEndPosition()),
    });
  }

  private handleEnd(): void {
    this.state = endComposition(this.state);
    if (this.state.phase !== 'settling') return;
    const generation = ++this.generation;
    this.scheduleSettle(() => {
      if (generation !== this.generation) return;
      this.state = settleComposition(this.state);
    });
  }

  private reset(): void {
    this.generation++;
    this.state = IDLE_COMPOSITION;
  }
}
