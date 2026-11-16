/**
 * compositionCorrelation - IME の composition と Monaco の編集を対応付ける純関数 (#720)
 *
 * 以前は「CJK の文字を含む複数文字の挿入」を文字種だけで IME の確定とみなしていたので、composition を
 * 経ない長い直接挿入 (拡張機能などの executeEdits) が `insertFromComposition` になり、一括挿入の評価を
 * 素通りしていた。ここでは「実際に composition が起きていて、編集の範囲がその領域に重なるか接する」
 * ときだけ composition に帰属させる。
 *
 * 状態は 3 つ:
 *  - `idle`: composition していない。どの編集も帰属しない
 *  - `composing`: compositionStart から compositionEnd まで。領域に重なる・接する編集は `composing`
 *  - `settling`: compositionEnd の直後。確定の編集が end より後に届く環境のため、領域に対応する
 *    最初の 1 件だけを `committed` とし、idle に戻る (ワンショット)。編集が来なければアダプタが
 *    タスク境界で `settle` を呼んで閉じる。壁時計の窓は使わない
 *
 * 領域は model 上の offset の半開区間 `[start, end)`。最初の編集の前は開始時の選択範囲で、
 * 対応した編集ごとに「置き換えた範囲を含めて広げ、挿入した長さで伸縮」させる。隣接 (区間の端に
 * 接する) を対応に含めるのは、再変換がキャレットの前の既存テキストを置き換えるため。
 */

/** contentChange 1 件の帰属。`none` は composition と対応しない (従来の分類に回す)。 */
export type CompositionAttribution = 'none' | 'composing' | 'committed';

/** model 上の offset の半開区間。 */
export interface OffsetRegion {
  readonly start: number;
  readonly end: number;
}

export type CompositionState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'composing' | 'settling'; readonly modelKey: string; readonly region: OffsetRegion };

/** 対応付けに使う編集の形 (Monaco の `IModelContentChange` の部分集合)。 */
export interface CorrelatedChange {
  readonly rangeOffset: number;
  readonly rangeLength: number;
  readonly text: string;
}

export interface CorrelationResult {
  readonly attribution: CompositionAttribution;
  readonly state: CompositionState;
}

export const IDLE_COMPOSITION: CompositionState = { phase: 'idle' };

/**
 * compositionStart: 開始時の選択範囲 (キャレットなら空の区間) を領域にして composing に入る。
 * 直前の composition の状態 (settling を含む) は持ち越さない。
 */
export function startComposition(modelKey: string, selection: OffsetRegion): CompositionState {
  const start = Math.min(selection.start, selection.end);
  const end = Math.max(selection.start, selection.end);
  return { phase: 'composing', modelKey, region: { start, end } };
}

/** compositionEnd: composing なら settling に移る。それ以外はそのまま。 */
export function endComposition(state: CompositionState): CompositionState {
  if (state.phase !== 'composing') return state;
  return { phase: 'settling', modelKey: state.modelKey, region: state.region };
}

/** settling を閉じる (確定の編集が来なかった)。settling 以外はそのまま。 */
export function settleComposition(state: CompositionState): CompositionState {
  return state.phase === 'settling' ? IDLE_COMPOSITION : state;
}

/** 編集の置き換え範囲 `[rangeOffset, rangeOffset + rangeLength]` が領域と交差するか接するか。 */
function touchesRegion(change: CorrelatedChange, region: OffsetRegion): boolean {
  return change.rangeOffset <= region.end && change.rangeOffset + change.rangeLength >= region.start;
}

/** 対応した編集を適用した後の領域: 置き換えた範囲まで広げ、挿入した長さの差だけ末尾を動かす。 */
function grownRegion(change: CorrelatedChange, region: OffsetRegion): OffsetRegion {
  const start = Math.min(region.start, change.rangeOffset);
  const endBefore = Math.max(region.end, change.rangeOffset + change.rangeLength);
  return { start, end: endBefore + change.text.length - change.rangeLength };
}

/** 対応しない編集が領域より前にあれば、その長さの差だけ領域をずらす (後ろなら動かない)。 */
function shiftedRegion(change: CorrelatedChange, region: OffsetRegion): OffsetRegion {
  if (change.rangeOffset + change.rangeLength > region.start) return region;
  const delta = change.text.length - change.rangeLength;
  return { start: region.start + delta, end: region.end + delta };
}

/**
 * contentChange 1 件を今の composition に対応付ける。同じイベントの複数 changes は記録と同じ順に
 * 1 件ずつ渡す (前の change が動かした領域で次を判定する)。
 */
export function correlateChange(
  state: CompositionState,
  modelKey: string,
  change: CorrelatedChange
): CorrelationResult {
  if (state.phase === 'idle') return { attribution: 'none', state };
  if (state.modelKey !== modelKey) return { attribution: 'none', state };

  if (!touchesRegion(change, state.region)) {
    return { attribution: 'none', state: { ...state, region: shiftedRegion(change, state.region) } };
  }

  if (state.phase === 'settling') {
    return { attribution: 'committed', state: IDLE_COMPOSITION };
  }
  return { attribution: 'composing', state: { ...state, region: grownRegion(change, state.region) } };
}
