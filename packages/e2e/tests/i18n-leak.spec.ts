import { test, expect } from '@playwright/test';
import { findTranslationKeyLeaks, watchI18nWarnings } from './helpers/uiInvariants.js';
import { blockExternalRequests, FLOW_SCREENS, TOUR_FLOWS, walkTour } from './helpers/uiTour.js';
import { VerifyWebApp } from './helpers/verifyWeb.js';

/**
 * i18n の漏れの検査 (#728 / #346 PR 6)。対象画面 (helpers/uiTour.ts) を ja と en の両方で巡り、
 * 翻訳キーの名前そのもの (`statusBar.events` など) が画面に出ていないこと、翻訳を引けなかったときの
 * I18nService の警告が出ていないことを見る。翻訳の文言は比べない。
 * ja / en のキー集合の一致は各パッケージのユニットテスト (`src/i18n/__tests__/translationKeys.test.ts`) が見る。
 */

const LOCALES = [
  { locale: 'ja-JP', lang: 'ja' },
  { locale: 'en-US', lang: 'en' },
] as const;

for (const { locale, lang } of LOCALES) {
  test.describe(`${lang}`, () => {
    test.use({ locale });

    for (const flow of TOUR_FLOWS) {
      test(`${flow} (${lang}): no translation key name is shown on ${FLOW_SCREENS[flow].join(', ')}`, async ({
        page,
      }) => {
        const warnings = watchI18nWarnings(page);
        await walkTour(page, flow, async (screen) => {
          // ブラウザの言語どおりの表示言語で開いている (違う言語で巡って緑にしない)
          await expect(page.locator('html')).toHaveAttribute('lang', lang);
          expect.soft(await findTranslationKeyLeaks(page), `${screen}: translation keys shown as text`).toEqual([]);
        });
        expect(warnings(), 'I18nService could not resolve these keys').toEqual([]);
      });
    }
  });
}

// 負の対照: 検出器が効いていて、キーに似た別物 (ファイル名・URL・バージョン) を拾わないこと。
test('the key-leak check reports key-shaped text and ignores file names and URLs', async ({ page }) => {
  await blockExternalRequests(page);
  const web = new VerifyWebApp(page);
  await web.open('fast');
  expect(await findTranslationKeyLeaks(page), 'the untouched page has no leak').toEqual([]);

  await page.evaluate(() => {
    const box = document.createElement('div');
    box.id = 'e2e-leak-probe';
    // 実在するキー / 名前空間と 2 段目が実在する (3 段目が欠けた) キー / 名前空間だけ一致するファイル名・URL・版
    box.textContent = 'common.cancel sidebar.title.missingLeaf about.zip main.c https://typedcode.example/a.b v1.2.3';
    box.title = 'welcome.browseButton';
    document.body.prepend(box);
  });
  expect(await findTranslationKeyLeaks(page)).toEqual([
    'common.cancel',
    'sidebar.title.missingLeaf',
    'welcome.browseButton',
  ]);

  // コード・プレビューなど利用者の内容の領域は読まない
  await page.evaluate(() => {
    const probe = document.getElementById('e2e-leak-probe')!;
    probe.textContent = '';
    probe.removeAttribute('title');
    const pre = document.createElement('pre');
    pre.textContent = 'common.cancel';
    probe.append(pre);
  });
  expect(await findTranslationKeyLeaks(page)).toEqual([]);
});
