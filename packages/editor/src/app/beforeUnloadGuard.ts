/**
 * ページ離脱 (beforeunload) のハンドラ。
 *
 * 離脱の確認ダイアログと、リロード復元のための状態保存 (sessionStorage 同期保存とリロード検出フラグ) は
 * 別物として扱う:
 *
 * - `skipBeforeUnload` (リセット確定): 全消去して起動し直すので、**保存も確認も両方飛ばす**
 * - `skipUnloadConfirm` (ModeSwitcher のモード移動・表示言語の切替): 作業は失われず同じセッションが
 *   続くので、**確認だけ出さず、保存は通常どおり行う**。ここで `skipBeforeUnload` を流用すると
 *   リロード復元に必要な保存まで飛び、セッションとチェーンが続かなくなる (#445)
 */

import type { AppContext } from '../core/AppContext.js';
import { sessionActiveKey } from '../core/storageKeys.js';

/** ハンドラが読む ctx の部分 (テストでは最小のスタブで足りる)。 */
export type BeforeUnloadContext = Pick<AppContext, 'skipBeforeUnload' | 'skipUnloadConfirm' | 'tabManager'>;

export function handleBeforeUnload(ctx: BeforeUnloadContext, e: Pick<BeforeUnloadEvent, 'preventDefault'>): void {
  if (ctx.skipBeforeUnload) return;

  // セッションをアクティブとしてマーク（リロード検出用）
  // sessionStorageはリロード時は保持され、タブを閉じると消える
  // 次回起動時にこのフラグがあればリロード、なければタブを閉じた後の再開
  try {
    sessionStorage.setItem(sessionActiveKey(), 'true');
  } catch {
    // ignore
  }

  // 最新のタブ状態をsessionStorageに同期的に保存
  // - リロード時：sessionStorageは保持されるため、最新状態が復元可能になる
  // - タブ閉じ時：sessionStorageは消えるため効果なし（IndexedDBから復元）
  // PoSW計算中でもMonacoモデルから最新コンテンツを取得して保存
  // 重要: beforeunloadではasync処理が完了しないため、同期的に保存する
  try {
    ctx.tabManager?.saveToStorageSync();
  } catch {
    // ignore - sessionStorageへの同期保存も失敗する可能性がある（QuotaExceeded等）
  }

  // 作業が失われない遷移 (モード移動・表示言語の切替) では確認を出さない
  if (ctx.skipUnloadConfirm) return;

  const activeProof = ctx.tabManager?.getActiveProof();
  if (activeProof && activeProof.events.length > 0) {
    e.preventDefault();
  }
}
