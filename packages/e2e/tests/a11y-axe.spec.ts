import { test, expect } from '@playwright/test';
import { diffA11y, expectNoNewA11yViolations, scanA11y } from './helpers/a11y.js';
import { EditorApp } from './helpers/app.js';
import { FLOW_SCREENS, TOUR_FLOWS, blockExternalRequests, settle, walkTour } from './helpers/uiTour.js';

/**
 * a11y の退行検査 (#728 / #346 PR 6)。対象画面 (helpers/uiTour.ts) を巡り、各画面に axe をかけて、
 * 既知違反の基準 (helpers/a11yBaseline.ts) から増えていないことを見る。
 *
 * 基準の selector に英語の title を含むものがあるので、表示言語は en に固定する。
 * axe が通ることはスクリーンリーダーで実際に操作できることの確認ではない (#305。docs は packages/e2e/README.md)。
 */

test.use({ locale: 'en-US' });

for (const flow of TOUR_FLOWS) {
  test(`${flow}: no axe violation beyond the known baseline on ${FLOW_SCREENS[flow].join(', ')}`, async ({ page }) => {
    await walkTour(page, flow, (screen) => expectNoNewA11yViolations(page, screen));
  });
}

// 負の対照: 検査が効いていること。About ダイアログの閉じるボタンから名前 (aria-label) を、ダイアログから
// role を外すと、どちらも基準に無い新しい違反として拾われる。
test('the axe check reports a dropped aria-label and a dropped dialog role as new violations', async ({ page }) => {
  await blockExternalRequests(page);
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await page.locator('#settings-btn').click();
  await page.locator('#about-btn').click();
  await page.locator('.modal-about[role="dialog"]').waitFor({ state: 'visible' });
  await settle(page);
  expect(
    diffA11y('casual-about', await scanA11y(page)).unexpected,
    'the unmodified dialog is within the baseline'
  ).toEqual([]);

  const closeBtn = page.locator('.modal-about .modal-close-btn');
  const label = await closeBtn.getAttribute('aria-label');
  await closeBtn.evaluate((el) => el.removeAttribute('aria-label'));
  const unnamed = diffA11y('casual-about', await scanA11y(page)).unexpected;
  expect(unnamed.map((v) => `${v.rule} ${v.target}`)).toContain('button-name .modal-close-btn');
  await closeBtn.evaluate((el, value) => el.setAttribute('aria-label', value), label ?? '');

  // role の無い div に aria-modal / aria-labelledby が残る (= dialog として読み上げられない)
  await page.locator('.modal-about[role="dialog"]').evaluate((el) => el.removeAttribute('role'));
  const roleless = diffA11y('casual-about', await scanA11y(page)).unexpected;
  expect(roleless.map((v) => `${v.rule} ${v.target}`)).toContain('aria-allowed-attr .modal-about');
});
