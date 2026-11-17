/**
 * InstanceConflictDialogs - 別のタブに同じセッションを再開され、このタブが読み取り専用になったことを知らせる画面 (#237)
 *
 * 全面のブロック画面 (`showLockOverlay`。画面共有ロック・アイドル停止と同じ流儀) で、閉じる手段を持たない。
 * ボタンは 2 つ:
 * - `data-action="rescue"`: その時点のコードを救出ファイルで出す (#300 段階 1 の救出経路をそのまま呼ぶ)。
 *   押しても画面は閉じない (何度でも押せる)
 * - `data-action="close"`: このタブを閉じる (`duplicate-instance` と同じ)
 *
 * 状態契約は `data-dialog="instance-conflict"` (packages/editor/AGENTS.md「状態契約」)。本番では console が
 * 消える (`esbuild.drop`) ので、競合はこの画面で知らせる。
 */

import { t } from '../../i18n/index.js';
import { showLockOverlay } from '../components/Modal.js';

export const INSTANCE_CONFLICT_OVERLAY_ID = 'instance-conflict-overlay';

export interface InstanceConflictActions {
  /** その時点のコードを救出する (RescueExporter.rescueAll)。待たない */
  onRescue: () => void;
  /** このタブを閉じる */
  onClose: () => void;
}

/** 競合の画面を出す。もう出ていれば作り直す (ボタンの配線を重ねない) */
export function showInstanceConflictOverlay(actions: InstanceConflictActions): void {
  showLockOverlay({
    overlayId: INSTANCE_CONFLICT_OVERLAY_ID,
    title: t('instanceConflict.title'),
    description: t('instanceConflict.description'),
    hint: t('instanceConflict.hint'),
    buttonText: t('instanceConflict.rescue'),
    icon: 'window-restore',
    className: 'instance-conflict-overlay',
    dialogName: 'instance-conflict',
    // false を返して画面を閉じない (救出の後も記録は止まったまま)
    onResume: async () => {
      actions.onRescue();
      return false;
    },
    secondaryButtonText: t('instanceConflict.closeThisTab'),
    onSecondaryAction: async () => {
      actions.onClose();
      return false;
    },
  });

  // showLockOverlay のボタンは再開用のアイコンなので、この画面の意味に合わせて差し替え、E2E 用に data-action を付ける
  const overlay = document.getElementById(INSTANCE_CONFLICT_OVERLAY_ID);
  const rescueBtn = overlay?.querySelector<HTMLElement>('.instance-conflict-content-btn');
  const closeBtn = overlay?.querySelector<HTMLElement>('.instance-conflict-content-btn-secondary');
  if (rescueBtn) {
    rescueBtn.dataset.action = 'rescue';
    const icon = rescueBtn.querySelector('i');
    if (icon) icon.className = 'fas fa-life-ring';
  }
  if (closeBtn) {
    closeBtn.dataset.action = 'close';
    const icon = closeBtn.querySelector('i');
    if (icon) icon.className = 'fas fa-times';
  }
}
