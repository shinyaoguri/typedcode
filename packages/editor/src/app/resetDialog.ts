/**
 * リセット確認ダイアログ (`#reset-dialog`) の差し込みと確定処理 (#323)。
 *
 * リセットが消すのは現在のモードのデータだけ (`utils/StorageClearHelper.ts`)。ダイアログには、消えるモード名と
 * そのモードのタブ数を開くたびに差し込む。静的 HTML の `#reset-scope` に、表示文のほか、E2E が読む状態契約の
 * `data-mode` (モード id) と `data-tab-count` (タブ数) も付ける。
 */

import type { AppContext } from '../core/AppContext.js';
import type { EditorMode } from '../core/mode.js';
import { t } from '../i18n/index.js';
import { showStaticDialog, type DialogA11yHandle } from '../ui/components/dialogA11y.js';
import { clearCurrentModeData } from '../utils/StorageClearHelper.js';
import { showNotification } from './AppHelpers.js';

/** `#reset-scope` に、消えるモード名とタブ数の文と状態契約の属性を差し込む。 */
export function fillResetScope(
  el: Pick<HTMLElement, 'textContent' | 'setAttribute'>,
  mode: EditorMode,
  tabCount: number
): void {
  el.textContent = t('resetDialog.scope', { mode: t(`feature.${mode}`), count: tabCount });
  el.setAttribute('data-mode', mode);
  el.setAttribute('data-tab-count', String(tabCount));
}

/** ダイアログを開く直前に呼ぶ。現在のモードとタブ数を差し込む。 */
export function prepareResetDialog(ctx: Pick<AppContext, 'mode' | 'tabManager'>): void {
  const scope = document.getElementById('reset-scope');
  if (scope) fillResetScope(scope, ctx.mode, ctx.tabManager?.getTabCount() ?? 0);
}

/**
 * リセットの確定。現在のモードのデータを消し、**消し終わってから**パラメータ無しの URL でリロードする。
 *
 * 失敗したとき (他のタブが同じ DB を開いていて削除が blocked など) はリロードせず、通知を出して
 * 離脱確認を元に戻す。保存は止めたままなので、手動のリロードで復旧する。
 */
export async function confirmReset(ctx: Pick<AppContext, 'skipBeforeUnload' | 'tabManager'>): Promise<void> {
  // 以後の保存 (beforeunload の同期保存を含む) が、消した状態を書き戻さないようにする
  ctx.skipBeforeUnload = true;
  ctx.tabManager?.suspendPersistence();

  try {
    await clearCurrentModeData();
  } catch (e) {
    console.error('[TypedCode] Reset failed:', e);
    ctx.skipBeforeUnload = false;
    showNotification(t('resetDialog.failed'));
    return;
  }

  window.location.href = window.location.origin + window.location.pathname;
}

/**
 * 設定メニューの「このモードをリセット」(`#reset-btn`) とダイアログの開閉・確定を配線する。
 *
 * a11y (#305): 開くと `dialogA11y` の `showStaticDialog` が role / aria-modal / aria-labelledby を付け、
 * 初期フォーカスを取り消し側 (キャンセル) に置き、Tab を閉じ込める。キャンセル・overlay・Escape・確定の
 * どれで閉じても同じ冪等な `close` を通り、Escape のリスナーはそこで解放される。閉じた後のフォーカスは、
 * 閉じた設定メニューの項目ではなく設定ボタン (`aria-controls` の制御元) へ戻る。
 */
export function setupResetDialog(
  ctx: Pick<AppContext, 'mode' | 'tabManager' | 'skipBeforeUnload' | 'settingsDropdown'>
): void {
  const resetDialog = document.getElementById('reset-dialog');
  if (!resetDialog) return;
  let handle: DialogA11yHandle | null = null;

  const close = (): void => {
    handle?.close();
    handle = null;
  };

  // リセットボタン（設定メニュー内）をクリックしてダイアログを表示
  document.getElementById('reset-btn')?.addEventListener('click', () => {
    // 設定ボタンの aria-expanded も一緒に戻すため、クラスを直に外さず SettingsDropdown を通す (#743)
    ctx.settingsDropdown.close();
    // 消えるモード名とタブ数を差し込んでから開く (#323)
    prepareResetDialog(ctx);
    close();
    handle = showStaticDialog(resetDialog, {
      initialFocus: document.getElementById('reset-cancel-btn'),
      onRequestClose: close,
    });
  });

  // キャンセルボタン
  document.getElementById('reset-cancel-btn')?.addEventListener('click', close);

  // オーバーレイクリックで閉じる
  resetDialog.addEventListener('click', (e) => {
    if (e.target === resetDialog) close();
  });

  // リセット確認ボタン - イベント委任を使用
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    // ボタン自体またはその子要素（アイコン、テキスト）がクリックされた場合
    const confirmBtn = target.closest('#reset-confirm-btn');
    if (!confirmBtn) return;

    e.preventDefault();
    e.stopPropagation();

    console.log('[TypedCode] Reset confirmed via event delegation');

    // ダイアログを閉じる
    close();

    // 現在のモードのデータを消し、完了してからパラメータ無しでリロードする (#323)
    void confirmReset(ctx);
  });
}
