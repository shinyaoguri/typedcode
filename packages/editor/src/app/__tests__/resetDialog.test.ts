/**
 * リセットの確認ダイアログと確定処理のテスト (#323)。
 *
 * - ダイアログには、消えるモード名とそのモードのタブ数を差し込む (状態契約 data-mode / data-tab-count も)
 * - 確定は「保存を止める → 現在のモードのデータの削除の完了を待つ → パラメータ無しの URL へ遷移」の順で、
 *   削除が失敗したら遷移しない
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../i18n/index.js', () => ({
  t: (key: string, params?: Record<string, string | number>) =>
    params
      ? `${key}(${Object.entries(params)
          .map(([k, v]) => `${k}=${v}`)
          .join(',')})`
      : key,
}));

const clearCurrentModeData = vi.fn<() => Promise<void>>();
vi.mock('../../utils/StorageClearHelper.js', () => ({
  clearCurrentModeData: () => clearCurrentModeData(),
}));

const showNotification = vi.fn();
vi.mock('../AppHelpers.js', () => ({
  showNotification: (message: string) => showNotification(message),
}));

const { fillResetScope, confirmReset } = await import('../resetDialog.js');

describe('fillResetScope', () => {
  it('writes the mode name and the tab count into the dialog text and the state contract attributes', () => {
    const attrs = new Map<string, string>();
    const el = { textContent: '', setAttribute: (k: string, v: string) => void attrs.set(k, v) };

    fillResetScope(el, 'assignment', 3);

    expect(el.textContent).toBe('resetDialog.scope(mode=feature.assignment,count=3)');
    expect(attrs.get('data-mode')).toBe('assignment');
    expect(attrs.get('data-tab-count')).toBe('3');
  });

  it('shows a zero tab count as 0, not as an empty value', () => {
    const attrs = new Map<string, string>();
    const el = { textContent: '', setAttribute: (k: string, v: string) => void attrs.set(k, v) };

    fillResetScope(el, 'casual', 0);

    expect(attrs.get('data-tab-count')).toBe('0');
  });
});

describe('confirmReset', () => {
  let location: { origin: string; pathname: string; href: string };

  function makeCtx() {
    return { skipBeforeUnload: false, tabManager: { suspendPersistence: vi.fn() } };
  }

  beforeEach(() => {
    clearCurrentModeData.mockReset();
    showNotification.mockReset();
    location = {
      origin: 'https://typedcode.test',
      pathname: '/assignment',
      href: 'https://typedcode.test/assignment?reset=1',
    };
    vi.stubGlobal('window', { location });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reloads on the parameter-less url only after the deletion has completed', async () => {
    let finishDeletion: () => void = () => {};
    clearCurrentModeData.mockReturnValue(new Promise<void>((resolve) => (finishDeletion = resolve)));
    const ctx = makeCtx();

    const done = confirmReset(ctx as never);
    await Promise.resolve();
    // 削除の完了前は遷移しない。保存は止めてある
    expect(location.href).toBe('https://typedcode.test/assignment?reset=1');
    expect(ctx.tabManager.suspendPersistence).toHaveBeenCalledTimes(1);
    expect(ctx.skipBeforeUnload).toBe(true);

    finishDeletion();
    await done;

    expect(location.href).toBe('https://typedcode.test/assignment');
  });

  it('does not reload, restores the leave confirmation and tells the user when the deletion fails', async () => {
    clearCurrentModeData.mockRejectedValue(new Error('blocked'));
    const ctx = makeCtx();

    await confirmReset(ctx as never);

    expect(location.href).toBe('https://typedcode.test/assignment?reset=1');
    expect(ctx.skipBeforeUnload).toBe(false);
    expect(showNotification).toHaveBeenCalledWith('resetDialog.failed');
  });
});
