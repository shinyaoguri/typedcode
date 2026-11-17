/**
 * 実行の診断 (`ParsedError`) をエディタのマーカーにする先を、run の所有タブ (実行を始めたタブ) で決める (#741)。
 *
 * main.ts の onShowErrors / onClearErrors はこれだけを呼ぶ。表示中のタブ (`getActiveTab`) に付けると、
 * 実行中にタブを切り替えたとき診断が別のタブに付き、元のタブには前の実行のマーカーが残る。
 * マーカーはそのタブの最後の実行結果に属し、そのタブを次に実行する開始時に消す (他のタブの実行では消さない)。
 * `ownerTabId` は記録先 (#698、`recordToOwnerTab`) と同じ `ExecutionTarget.ownerTabId`。
 */

import type { ParsedError } from '../executors/interfaces/ILanguageExecutor.js';
import { resolveMarkerRange, type LineBoundedModel, type MarkerRange } from '../executors/errorMarkerRange.js';

/** `setModelMarkers` の owner。全言語の実行の診断で共通 */
export const EXECUTION_MARKER_OWNER = 'c-compiler';

/** `ITextModel` のうちマーカーを付けるのに使う部分 (テストで偽物を渡せるようにする) */
export interface MarkerModel extends LineBoundedModel {
  isDisposed(): boolean;
}

export interface ExecutionMarker extends MarkerRange {
  message: string;
  severity: ParsedError['severity'];
}

/** `TabManager` のうち所有タブのモデルを引く部分 */
export interface OwnerTabLookup<M extends MarkerModel> {
  getTab(tabId: string): { model: M } | null;
}

export type SetModelMarkers<M extends MarkerModel> = (model: M, owner: string, markers: ExecutionMarker[]) => void;

/** 所有タブのモデル。所有者の無い run・閉じられたタブ・dispose 済みのモデルは null (Monaco に渡すと throw する) */
function ownerModel<M extends MarkerModel>(
  tabs: OwnerTabLookup<M> | null | undefined,
  ownerTabId: string | undefined
): M | null {
  if (ownerTabId === undefined) return null;
  const model = tabs?.getTab(ownerTabId)?.model;
  if (!model || model.isDisposed()) return null;
  return model;
}

/** 所有タブのモデルに診断のマーカーを付ける (同じ owner の既存のマーカーは置き換わる) */
export function showErrorsInOwnerTab<M extends MarkerModel>(
  tabs: OwnerTabLookup<M> | null | undefined,
  ownerTabId: string | undefined,
  errors: ParsedError[],
  setModelMarkers: SetModelMarkers<M>
): void {
  const model = ownerModel(tabs, ownerTabId);
  if (!model) return;
  setModelMarkers(
    model,
    EXECUTION_MARKER_OWNER,
    errors.map((err) => ({ ...resolveMarkerRange(model, err), message: err.message, severity: err.severity }))
  );
}

/** 所有タブのモデルのマーカーを消す (そのタブの次の run の開始で呼ぶ) */
export function clearErrorsInOwnerTab<M extends MarkerModel>(
  tabs: OwnerTabLookup<M> | null | undefined,
  ownerTabId: string | undefined,
  setModelMarkers: SetModelMarkers<M>
): void {
  const model = ownerModel(tabs, ownerTabId);
  if (!model) return;
  setModelMarkers(model, EXECUTION_MARKER_OWNER, []);
}
