import { test, expect, type Locator, type Page } from '@playwright/test';
import { EditorApp } from './helpers/app.js';
import { failStorageProbe } from './helpers/faults.js';
import { openSelfReviewForExport, waitDialogClosed, waitDialogOpen } from './helpers/scenario.js';

/**
 * 共通ダイアログのフォーカス管理 (#305)。About ダイアログ (設定メニュー → About) を実ブラウザで開き、
 * aria 属性・Tab の閉じ込め・閉じたあとのフォーカス復帰を見る。
 * 翻訳テキストや見た目には依存せず、role / aria / フォーカス位置だけを読む。
 * (role・名前・リスナー解放の網羅は editor の単体テスト `Modal.test.ts` / `AboutDialog.test.ts`。
 *  ここは Tab の物理的な移動が実ブラウザで背景へ抜けないことを担う)
 * 段階 2: DOM 生成型の `SessionRecoveryDialog` (`data-dialog="session-recovery"`) と
 * `SelfReviewDialog` (`data-dialog="self-review"`) も同じ観点で見る。
 */

const DIALOG = '.modal-about[role="dialog"]';

async function openAbout(page: Page): Promise<void> {
  await page.locator('#settings-btn').click();
  await page.locator('#about-btn').click();
  await page.locator(DIALOG).waitFor({ state: 'visible' });
}

/** フォーカスがダイアログの内側にあるか。 */
function focusInsideDialog(page: Page): Promise<boolean> {
  return page.evaluate(
    (selector) => document.querySelector(selector)?.contains(document.activeElement) ?? false,
    DIALOG
  );
}

test.describe('About dialog accessibility', () => {
  test.beforeEach(async ({ page }) => {
    const app = new EditorApp(page);
    await app.openCasualFresh();
    await openAbout(page);
  });

  test('exposes dialog semantics with an accessible name and moves focus into it on open', async ({ page }) => {
    const dialog = page.locator(DIALOG);
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    const labelId = await dialog.getAttribute('aria-labelledby');
    expect(labelId, 'aria-labelledby must be set').toBeTruthy();
    await expect(page.locator(`[id="${labelId}"]`)).not.toBeEmpty();
    expect(await focusInsideDialog(page)).toBe(true);
  });

  test('keeps focus inside the dialog through repeated Tab and Shift+Tab', async ({ page }) => {
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      expect(await focusInsideDialog(page), `Tab #${i + 1}`).toBe(true);
    }
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await focusInsideDialog(page), `Shift+Tab #${i + 1}`).toBe(true);
    }
  });

  test('closes on Escape and returns focus to the settings button', async ({ page }) => {
    await page.keyboard.press('Escape');
    await expect(page.locator(DIALOG)).toHaveCount(0);
    await expect(page.locator('#settings-btn')).toBeFocused();
  });

  test('keeps trapping focus after being closed with the button and opened again', async ({ page }) => {
    await page.locator(`${DIALOG} .modal-close-btn`).click();
    await expect(page.locator(DIALOG)).toHaveCount(0);
    await expect(page.locator('#settings-btn')).toBeFocused();

    await openAbout(page);
    expect(await focusInsideDialog(page)).toBe(true);
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      expect(await focusInsideDialog(page), `Tab #${i + 1}`).toBe(true);
    }
  });
});

/** `data-dialog` の overlay 配下の role=dialog 要素。 */
const dialogOf = (page: Page, name: string): Locator => page.locator(`[data-dialog="${name}"] [role="dialog"]`);

/** フォーカスが指定ダイアログの内側にあるか。 */
function focusInside(page: Page, name: string): Promise<boolean> {
  return page.evaluate(
    (n) => document.querySelector(`[data-dialog="${n}"] [role="dialog"]`)?.contains(document.activeElement) ?? false,
    name
  );
}

test('the session recovery dialog is a named modal dialog that traps Tab and cannot be dismissed with Escape', async ({
  page,
  context,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int a = 1;\n');
  await app.waitForSynced();
  await page.close();

  // タブを閉じて再訪すると、sessionStorage が無いので復旧ダイアログが出る
  const page2 = await context.newPage();
  const app2 = new EditorApp(page2);
  await page2.goto('/casual');
  await waitDialogOpen(app2, 'session-recovery');

  const dialog = dialogOf(page2, 'session-recovery');
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  const labelId = await dialog.getAttribute('aria-labelledby');
  expect(labelId, 'aria-labelledby must be set').toBeTruthy();
  await expect(page2.locator(`[id="${labelId}"]`)).not.toBeEmpty();
  expect(await focusInside(page2, 'session-recovery')).toBe(true);

  for (let i = 0; i < 6; i++) {
    await page2.keyboard.press('Tab');
    expect(await focusInside(page2, 'session-recovery'), `Tab #${i + 1}`).toBe(true);
  }
  for (let i = 0; i < 6; i++) {
    await page2.keyboard.press('Shift+Tab');
    expect(await focusInside(page2, 'session-recovery'), `Shift+Tab #${i + 1}`).toBe(true);
  }

  // 選択が必須なので Escape では閉じない
  await page2.keyboard.press('Escape');
  expect(await app2.openDialogs()).toContain('session-recovery');

  await page2.locator('#session-resume-btn').click();
  await waitDialogClosed(app2, 'session-recovery');
});

test('the self-review dialog is a named modal dialog that traps Tab and keeps a half-written note on Escape', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int a;');
  await app.waitForSynced();

  await openSelfReviewForExport(app);
  const dialog = dialogOf(page, 'self-review');
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  const labelId = await dialog.getAttribute('aria-labelledby');
  expect(labelId, 'aria-labelledby must be set').toBeTruthy();
  await expect(page.locator(`[id="${labelId}"]`)).not.toBeEmpty();
  await expect(page.locator('#self-review-note')).toBeFocused();

  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    expect(await focusInside(page, 'self-review'), `Tab #${i + 1}`).toBe(true);
  }
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await focusInside(page, 'self-review'), `Shift+Tab #${i + 1}`).toBe(true);
  }

  // Escape では閉じず、書きかけのノートも残る (閉じる手段はキャンセルボタン)
  await page.locator('#self-review-note').fill('draft');
  await page.keyboard.press('Escape');
  expect(await app.openDialogs()).toContain('self-review');
  await expect(page.locator('#self-review-note')).toHaveValue('draft');

  // 閉じたあとにフォーカスが消えたダイアログに残らない
  await page.locator('[data-dialog="self-review"] .self-review-btn-cancel').click();
  await waitDialogClosed(app, 'self-review');
  expect(await focusInside(page, 'self-review')).toBe(false);
  await app.expectConsistent();
});

// ---------------------------------------------------------------------------
// 残りの overlay (#305 の残作業): index.html の静的 overlay・タブ閉じ確認・countdown / lock overlay、
// メニュー項目から開いたダイアログの閉じた後のフォーカス
// ---------------------------------------------------------------------------

/** 指定ダイアログの role / aria-modal / aria-labelledby (名前が空でない) を見る。 */
async function expectNamedModal(page: Page, name: string): Promise<void> {
  const dialog = dialogOf(page, name);
  await expect(dialog).toHaveCount(1);
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  const labelId = await dialog.getAttribute('aria-labelledby');
  expect(labelId, `aria-labelledby of ${name} must be set`).toBeTruthy();
  await expect(page.locator(`[id="${labelId}"]`)).not.toBeEmpty();
}

/** Tab / Shift+Tab を何度押してもフォーカスがダイアログの内側に留まる。 */
async function expectTabTrapped(page: Page, name: string, presses = 6): Promise<void> {
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press('Tab');
    expect(await focusInside(page, name), `${name}: Tab #${i + 1}`).toBe(true);
  }
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await focusInside(page, name), `${name}: Shift+Tab #${i + 1}`).toBe(true);
  }
}

/** フォーカスが Monaco の中 (エディタ) にあるか。 */
function focusInEditor(page: Page): Promise<boolean> {
  return page.evaluate(() => document.querySelector('.monaco-editor')?.contains(document.activeElement) ?? false);
}

async function openReset(page: Page): Promise<void> {
  await page.locator('#settings-btn').click();
  await page.locator('#reset-btn').click();
}

test('the reset dialog is a named modal that traps Tab and returns focus to the settings button by every close route', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();

  await openReset(page);
  await waitDialogOpen(app, 'reset');
  await expectNamedModal(page, 'reset');
  // 破壊的な操作のダイアログなので、初期フォーカスは取り消し側
  await expect(page.locator('#reset-cancel-btn')).toBeFocused();
  await expectTabTrapped(page, 'reset');

  // Escape → 閉じた設定メニューの項目ではなく設定ボタンへ戻る
  await page.keyboard.press('Escape');
  await waitDialogClosed(app, 'reset');
  await expect(page.locator('#settings-btn')).toBeFocused();

  // 再表示してキャンセル
  await openReset(page);
  await waitDialogOpen(app, 'reset');
  expect(await focusInside(page, 'reset')).toBe(true);
  await page.locator('#reset-cancel-btn').click();
  await waitDialogClosed(app, 'reset');
  await expect(page.locator('#settings-btn')).toBeFocused();

  // 再表示して overlay のクリック。閉じた後の Escape で何も起きない (古いリスナーが残っていない)
  await openReset(page);
  await waitDialogOpen(app, 'reset');
  await page.locator('[data-dialog="reset"]').click({ position: { x: 5, y: 5 } });
  await waitDialogClosed(app, 'reset');
  await expect(page.locator('#settings-btn')).toBeFocused();
  await page.keyboard.press('Escape');
  expect(await app.openDialogs()).toEqual([]);
  await app.expectConsistent();
});

test('the tab close confirmation is a named modal that traps Tab and returns focus to the tab close button', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  const [tab] = await app.tabs();
  const closeBtn = page.locator(`.editor-tab[data-tab-id="${tab!.id}"] .tab-close-btn`);

  await app.requestCloseTab(tab!.id);
  await expectNamedModal(page, 'tab-close');
  await expect(page.locator('#tab-close-cancel-btn')).toBeFocused();
  await expectTabTrapped(page, 'tab-close');

  await page.keyboard.press('Escape');
  await waitDialogClosed(app, 'tab-close');
  await expect(closeBtn).toBeFocused();

  // 再表示してキャンセル
  await app.requestCloseTab(tab!.id);
  await app.answerCloseTab('cancel');
  await expect(closeBtn).toBeFocused();

  // 再表示して overlay のクリック
  await app.requestCloseTab(tab!.id);
  await page.locator('[data-dialog="tab-close"]').click({ position: { x: 5, y: 5 } });
  await waitDialogClosed(app, 'tab-close');
  await expect(closeBtn).toBeFocused();
  expect((await app.tabs()).map((t) => t.id)).toEqual([tab!.id]);
  await app.expectConsistent();
});

test('a dialog opened from the download button returns focus to the download button when it closes', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int a;');
  await app.waitForSynced();

  await openSelfReviewForExport(app);
  await page.locator('[data-dialog="self-review"] .self-review-btn-cancel').click();
  await waitDialogClosed(app, 'self-review');
  await expect(page.locator('#download-btn')).toBeFocused();
});

test('the terms modal at startup is a named modal that traps Tab and cannot be dismissed with Escape', async ({
  page,
}) => {
  const app = new EditorApp(page);
  // class は未同意なら起動時に規約モーダルを出す (casual は出さない = ADR-0015)
  await app.openModeFresh('class', { acceptTerms: false, waitReady: false });
  await waitDialogOpen(app, 'terms');
  await expectNamedModal(page, 'terms');
  expect(await focusInside(page, 'terms')).toBe(true);
  await expectTabTrapped(page, 'terms', 12);

  await page.keyboard.press('Escape');
  expect(await app.openDialogs()).toContain('terms');

  await page.locator('#terms-agree-checkbox').check();
  await page.locator('#terms-agree-btn').click();
  await waitDialogClosed(app, 'terms');
  expect(await focusInside(page, 'terms')).toBe(false);
});

test('the storage-low warning is a named modal that traps Tab and cannot be dismissed with Escape', async ({
  page,
}) => {
  await failStorageProbe(page, 'quota');
  const app = new EditorApp(page);
  await page.goto('/casual');
  await waitDialogOpen(app, 'storage-low');
  await expectNamedModal(page, 'storage-low');
  await expect(page.locator('#storage-low-continue-btn')).toBeFocused();
  await expectTabTrapped(page, 'storage-low');

  await page.keyboard.press('Escape');
  expect(await app.openDialogs()).toContain('storage-low');

  await page.locator('#storage-low-continue-btn').click();
  await waitDialogClosed(app, 'storage-low');
  await app.waitReady();
});

test('the idle warning and the suspended lock are named modals that trap Tab, ignore Escape and return focus to the editor', async ({
  page,
}) => {
  await page.clock.install();
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.focusEditor();

  // 1 回目: 警告に「続ける」で答える → エディタへ戻る
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.clock.fastForward('01:00:00');
  await waitDialogOpen(app, 'idle-warning');
  await expectNamedModal(page, 'idle-warning');
  await expect(page.locator('[data-dialog="idle-warning"] .countdown-continue-btn')).toBeFocused();
  await expectTabTrapped(page, 'idle-warning', 3);
  await page.keyboard.press('Escape');
  expect(await app.openDialogs()).toContain('idle-warning');
  await page.locator('[data-dialog="idle-warning"] .countdown-continue-btn').click();
  await waitDialogClosed(app, 'idle-warning');
  expect(await focusInEditor(page)).toBe(true);

  // 2 回目 (再表示): 時間切れでロック画面へ。再開ボタンで閉じる → エディタへ戻る
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.clock.fastForward('01:00:00');
  await waitDialogOpen(app, 'idle-warning');
  expect(await focusInside(page, 'idle-warning')).toBe(true);
  await page.clock.runFor('05:01');
  await waitDialogOpen(app, 'idle-suspended');
  await expectNamedModal(page, 'idle-suspended');
  await expect(page.locator('[data-dialog="idle-suspended"] .btn-primary')).toBeFocused();
  await expectTabTrapped(page, 'idle-suspended', 3);
  await page.keyboard.press('Escape');
  expect(await app.openDialogs()).toContain('idle-suspended');
  await page.locator('[data-dialog="idle-suspended"] .btn-primary').click();
  await waitDialogClosed(app, 'idle-suspended');
  expect(await focusInEditor(page)).toBe(true);
});
