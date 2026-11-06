import { test, expect } from '@playwright/test';
import { EditorApp, installTermsAccepted, readAllProofEvents, readProofEvents } from '../helpers/app.js';
import { runVerifyCli } from '../helpers/verifyCli.js';
import { waitDialogClosed, waitDialogOpen } from '../helpers/scenario.js';

/**
 * 入口 (#644。ADR-0015 のランディングを置き換え): `/` は練習のエディタを直接開き、学生にモードを選ばせない。
 *
 * - 練習は規約のモーダルを出さず、未同意なら利用規約の通知 (`[data-banner="terms"]`) を出す。通知には、どのモードでも
 *   証明しないことの注記 (`[data-note="scope"]`。#240) を添える。閉じたら同意として
 *   開いている全タブに termsAccepted を記録し、後から作るタブには #405 の流し直しで載る (どのタブもちょうど 1 件)
 * - `/class` `/assignment` `/exam` の直リンクは今までと同じ最初の画面 (`data-dialog`) になる
 * - titlebar のモード表示 (`.mode-badge[data-mode]`) は表示だけで、押しても別モードへ移るメニューは開かない
 *
 * 判定は `html[data-app-state]` / `html[data-mode]` / `data-dialog` / `data-banner` / proof のイベント列と
 * verify-cli の結論だけを読む (翻訳テキストは読まない)。
 */

const termsNotice = (app: EditorApp) => app.page.locator('[data-banner="terms"]');

test('規約に未同意で / を開くと規約モーダルは出ず通知が出て、OK で閉じた後の proof に termsAccepted がちょうど 1 件載る', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await page.goto('/');
  await app.waitReady();
  await expect.poll(() => app.appState()).toBe('ready');
  expect(await app.openDialogs()).not.toContain('terms');

  // 通知は利用規約を開くボタンと OK を持つ。
  const notice = termsNotice(app);
  await expect(notice).toBeVisible();
  await expect(notice.locator('[data-action="open-terms"]')).toBeVisible();
  await notice.locator('[data-action="ok"]').click();
  await expect(notice).toHaveCount(0);

  await app.typeCode('int a;');
  await app.waitForSynced();
  await app.expectConsistent();
  const zipPath = await app.exportCurrentTab();
  const events = await readProofEvents(zipPath);
  expect(events.filter((e) => e.type === 'termsAccepted')).toHaveLength(1);
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);

  // 同意は残るので、開き直しても通知は出ない。
  await app.reloadAndResume();
  await expect.poll(() => app.appState()).toBe('ready');
  await expect(termsNotice(app)).toHaveCount(0);
});

// どのモードでも証明しないことの注記 (#240 の D3) は、練習の規約通知の文の後ろに ja / en のどちらでも出る。
// 翻訳テキストは読まず、html[lang] でロケールを確かめたうえで、注記が見えて中身が空でないことだけを見る。
for (const [locale, lang] of [
  ['ja-JP', 'ja'],
  ['en-US', 'en'],
] as const) {
  test.describe(`規約通知の注記 (${lang})`, () => {
    test.use({ locale });

    test(`練習の規約通知に、証明しないことの注記が ${lang} で出る`, async ({ page }) => {
      const app = new EditorApp(page);
      await page.goto('/');
      await app.waitReady();
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
      const note = termsNotice(app).locator('[data-note="scope"]');
      await expect(note).toBeVisible();
      await expect(note).not.toHaveText(/^\s*$/);
    });
  });
}

test('通知から規約を開いて同意すると通知が閉じ、同意の前後に作ったどのタブにも termsAccepted がちょうど 1 件載る', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await page.goto('/');
  await app.waitReady();
  await app.typeCode('int a;');
  // 同意する前に作ったタブ。
  await app.addTab();
  await app.typeCode('int b;');

  await termsNotice(app).locator('[data-action="open-terms"]').click();
  await waitDialogOpen(app, 'terms');
  await page.locator('#terms-agree-checkbox').check();
  await page.locator('#terms-agree-btn').click();
  await waitDialogClosed(app, 'terms');
  await expect(termsNotice(app)).toHaveCount(0);

  // 同意した後に作ったタブ。
  await app.addTab();
  await app.typeCode('int c;');
  await app.waitForSynced();
  await app.expectConsistent();

  const zipPath = await app.exportAllTabs();
  const proofs = await readAllProofEvents(zipPath);
  expect(proofs.size).toBe(3);
  for (const [entry, events] of proofs) {
    expect(
      events.filter((e) => e.type === 'termsAccepted'),
      `termsAccepted exactly once in ${entry}`
    ).toHaveLength(1);
  }
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
});

test('規約に同意済みなら / で通知は出ない', async ({ page }) => {
  await installTermsAccepted(page);
  const app = new EditorApp(page);
  await page.goto('/');
  await app.waitReady();
  await expect.poll(() => app.appState()).toBe('ready');
  await expect(termsNotice(app)).toHaveCount(0);
});

/** 直リンクで開いたときの最初の画面 (`data-dialog`)。規約は同意済みの状態で開く。 */
const FIRST_SCREEN = {
  class: 'screen-share-choice',
  assignment: 'welcome',
  exam: 'screen-share-choice',
} as const;

for (const mode of ['class', 'assignment', 'exam'] as const) {
  test(`/${mode} の直リンクはそのモードの最初の画面になり、練習の規約通知は出ない`, async ({ page }) => {
    const app = new EditorApp(page);
    await app.openModeFresh(mode, { waitReady: false });
    await expect(page.locator('html')).toHaveAttribute('data-mode', mode);
    await waitDialogOpen(app, FIRST_SCREEN[mode]);
    expect(await app.openDialogs()).not.toContain('terms');
    if (mode === 'assignment') {
      // タブ 0 本のウェルカムでも DOM の状態契約と内部状態が一致する。
      await expect.poll(() => app.appState()).toBe('ready');
      await app.expectConsistent();
    }
    if (mode === 'exam') {
      await page.locator('.screen-share-choice-dialog [data-choice="share"]').click();
      await waitDialogOpen(app, 'exam-gate');
      await expect.poll(() => app.appState()).toBe('gate');
    }
    await expect(termsNotice(app)).toHaveCount(0);
  });
}

test('titlebar のモード表示を押しても、別モードへ移るメニューは開かない', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.waitForSynced();

  const badge = page.locator('.titlebar .mode-badge');
  await expect(badge).toHaveCount(1);
  await expect(badge).toHaveAttribute('data-mode', 'casual');
  const url = page.url();

  await badge.click();
  await badge.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');

  // メニュー (role=menu / menuitem) も、他モードの data-mode を持つ要素も出ない。URL もモードも変わらない。
  await expect(page.locator('[role="menu"], [role="menuitem"]')).toHaveCount(0);
  for (const other of ['class', 'assignment', 'exam']) {
    await expect(page.locator(`.titlebar [data-mode="${other}"]`)).toHaveCount(0);
  }
  expect(page.url()).toBe(url);
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'casual');
  await expect.poll(() => app.appState()).toBe('ready');
  await app.expectConsistent();
});
