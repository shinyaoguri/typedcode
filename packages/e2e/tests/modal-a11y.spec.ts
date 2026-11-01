import { test, expect, type Page } from '@playwright/test';
import { EditorApp } from './helpers/app.js';

/**
 * 共通ダイアログのフォーカス管理 (#305)。About ダイアログ (設定メニュー → About) を実ブラウザで開き、
 * aria 属性・Tab の閉じ込め・閉じたあとのフォーカス復帰を見る。
 * 翻訳テキストや見た目には依存せず、role / aria / フォーカス位置だけを読む。
 * (role・名前・リスナー解放の網羅は editor の単体テスト `Modal.test.ts` / `AboutDialog.test.ts`。
 *  ここは Tab の物理的な移動が実ブラウザで背景へ抜けないことを担う)
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
