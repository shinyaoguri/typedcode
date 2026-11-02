import { test, expect, type Locator, type Page } from '@playwright/test';
import { EditorApp } from './helpers/app.js';
import { openSelfReviewForCurrentTab, waitDialogClosed, waitDialogOpen } from './helpers/scenario.js';

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

  await openSelfReviewForCurrentTab(app);
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
