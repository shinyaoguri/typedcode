import { test, expect } from '@playwright/test';
import { EditorApp, readAllProofEvents } from '../helpers/app.js';
import { runVerifyCli } from '../helpers/verifyCli.js';
import { loadClassPackage, waitDialogClosed, waitDialogOpen } from '../helpers/scenario.js';

/**
 * #434-2: 利用規約 (class / assignment / exam で未同意なら出る。ADR-0015)。同意するまでアプリは
 * `initializing` に留まりエディタは無く、チェックを入れるまで同意ボタンは押せない。同意すると次の画面
 * (class なら画面共有の選択) へ進み、問題を読んでできたタブの proof に termsAccepted がちょうど 1 件載る (#405)。
 */
test('class: 規約に同意するまで先へ進めず、同意すると画面共有の選択へ進み proof に termsAccepted が 1 件載る', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openModeFresh('class', { acceptTerms: false, waitReady: false });

  await waitDialogOpen(app, 'terms');
  expect(await app.appState()).toBe('initializing');
  expect(await app.openDialogs()).not.toContain('screen-share-choice');
  // エディタに開くタブがまだ無い (= 打鍵の記録先が無い)。
  expect((await app.snapshot()).tabs).toEqual([]);
  expect(await app.eventCount()).toBe(0);

  const agree = page.locator('#terms-agree-btn');
  await expect(agree).toBeDisabled();
  await page.locator('#terms-agree-checkbox').check();
  await expect(agree).toBeEnabled();
  await agree.click();

  await waitDialogClosed(app, 'terms');
  await waitDialogOpen(app, 'screen-share-choice');
  await page.locator('.screen-share-choice-dialog [data-choice="share"]').click();
  await waitDialogOpen(app, 'welcome');
  await expect.poll(() => app.appState()).toBe('ready');

  await loadClassPackage(app);
  await app.typeCode('int a;');
  await app.expectConsistent();

  const zipPath = await app.exportViaLogButton();
  const proofs = await readAllProofEvents(zipPath);
  expect(proofs.size).toBeGreaterThan(0);
  for (const [entry, events] of proofs) {
    expect(
      events.filter((e) => e.type === 'termsAccepted'),
      `termsAccepted exactly once in ${entry}`
    ).toHaveLength(1);
  }
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  await app.expectConsistent();
});

// どのモードでも証明しないことの注記 (#240 の D3) は、規約モーダルの冒頭 (terms.intro の直後) に ja / en のどちらでも
// 出る。全モードの初回入場で見える場所。翻訳テキストは読まず、html[lang] でロケールを確かめたうえで、注記が見えて
// 中身が空でないことと、intro の次の要素であることだけを見る。
for (const [locale, lang] of [
  ['ja-JP', 'ja'],
  ['en-US', 'en'],
] as const) {
  test.describe(`規約モーダルの注記 (${lang})`, () => {
    test.use({ locale });

    test(`規約モーダルの冒頭に、証明しないことの注記が ${lang} で出る`, async ({ page }) => {
      const app = new EditorApp(page);
      await app.openModeFresh('class', { acceptTerms: false, waitReady: false });
      await waitDialogOpen(app, 'terms');
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
      const note = page.locator('[data-dialog="terms"] [data-note="scope"]');
      await expect(note).toBeVisible();
      await expect(note).not.toHaveText(/^\s*$/);
      const followsIntro = await note.evaluate(
        (el) => el.previousElementSibling?.getAttribute('data-i18n') === 'terms.intro'
      );
      expect(followsIntro).toBe(true);
    });
  });
}
