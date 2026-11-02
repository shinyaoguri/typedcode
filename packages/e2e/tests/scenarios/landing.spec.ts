import { test, expect } from '@playwright/test';
import { EditorApp } from '../helpers/app.js';
import { waitDialogOpen } from '../helpers/scenario.js';

/**
 * #434-1: ランディング (`/`、ADR-0015) のカードから 4 モードへ入れる・続きからバッジ・ModeSwitcher の
 * キーボード操作。判定は `html[data-app-state]` / `html[data-mode]` / `data-dialog` / バッジの
 * `data-tab-count` だけを読む。各モードのフロー自体 (問題の読み込み・試験ゲートの解錠) は別の spec の対象。
 */

/** カード経由で入ったあと、そのモードの最初の画面 (`data-dialog`) が出る。 */
const FIRST_SCREEN = {
  casual: null,
  class: 'screen-share-choice',
  assignment: 'welcome',
  exam: 'screen-share-choice',
} as const;

for (const mode of ['casual', 'class', 'assignment', 'exam'] as const) {
  test(`ランディングの ${mode} カードから /${mode} に入り、そのモードの最初の画面になる`, async ({ page }) => {
    const app = new EditorApp(page);
    await page.goto('/');
    await expect.poll(() => app.appState()).toBe('landing');

    const card = page.locator(`.landing-card-mode[data-mode="${mode}"]`);
    if (mode === 'assignment') {
      // キーボードでも入れる (カード内の「開始」ボタンに Enter。click がカードに伝わる)。
      await card.locator('.lc-open').focus();
      await page.keyboard.press('Enter');
    } else {
      await card.click();
    }
    await expect(page).toHaveURL(new RegExp(`/${mode}$`));
    await expect(page.locator('html')).toHaveAttribute('data-mode', mode);

    const first = FIRST_SCREEN[mode];
    if (first === null) {
      // casual は既定タブ 1 本で即編集できる (ADR-0015)。カード経由なので規約は出ない。
      await app.waitReady();
      await expect.poll(() => app.appState()).toBe('ready');
      expect(await app.openDialogs()).not.toContain('terms');
      await app.expectConsistent();
      return;
    }
    await waitDialogOpen(app, first);
    // カードを押した時点で規約は同意済みになる (= 規約のモーダルを出さない)。
    expect(await app.openDialogs()).not.toContain('terms');
    if (mode === 'exam') {
      await page.locator('.screen-share-choice-dialog [data-choice="share"]').click();
      await waitDialogOpen(app, 'exam-gate');
      await expect.poll(() => app.appState()).toBe('gate');
    }
  });
}

test('続きからバッジは、タブのあるセッションのモードにだけタブ数を出す (問題を読んでいない class には出ない)', async ({
  page,
  context,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int a = 1;\n');
  await app.waitForSynced();
  const tabCount = (await app.tabs()).length;
  await page.close();

  // 同じ origin の入口を別ページで開く (IndexedDB は context 内で共有)。
  const landing = await context.newPage();
  await landing.goto('/');
  const badge = (m: string) => landing.locator(`.landing-card-mode[data-mode="${m}"] .session-badge`);
  // 検出が終わると全カードに data-tab-count が付く (packages/editor/AGENTS.md「状態契約」)。
  await expect(badge('casual')).toHaveAttribute('data-tab-count', String(tabCount));
  await expect(badge('casual')).toBeVisible();
  for (const m of ['class', 'assignment', 'exam']) {
    await expect(badge(m)).toHaveAttribute('data-tab-count', '0');
    await expect(badge(m)).toBeHidden();
  }
});

test('ModeSwitcher はキーボードだけで開閉・移動でき、Enter で別モードへ移る', async ({ page }) => {
  const app = new EditorApp(page);
  // ModeSwitcher の遷移は skipBeforeUnload を立てないので、記録のあるタブでは離脱確認 (beforeunload) が出る
  // (製品側の問題として報告済み。再現は下の fixme)。ここでは確認を受け入れて遷移そのものを確かめる。
  page.on('dialog', (dialog) => void dialog.accept());
  await app.openCasualFresh();
  await app.waitForSynced();

  const btn = page.locator('#mode-switcher-btn');
  const focusedMode = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.mode ?? null);
  const focusedId = () => page.evaluate(() => document.activeElement?.id ?? null);

  await btn.focus();
  await page.keyboard.press('ArrowDown');
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  expect(await focusedMode()).toBe('casual');
  await page.keyboard.press('ArrowDown');
  expect(await focusedMode()).toBe('class');
  await page.keyboard.press('ArrowUp');
  expect(await focusedMode()).toBe('casual');
  // 端で折り返す
  await page.keyboard.press('ArrowUp');
  expect(await focusedMode()).toBe('exam');

  // Escape で閉じ、フォーカスがボタンに戻る。
  await page.keyboard.press('Escape');
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  expect(await focusedId()).toBe('mode-switcher-btn');
  await app.expectConsistent();

  // 開き直して assignment へ移る。
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  expect(await focusedMode()).toBe('assignment');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/assignment$/);
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'assignment');
});
