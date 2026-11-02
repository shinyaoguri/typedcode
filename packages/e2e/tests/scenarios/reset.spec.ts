import { test, expect } from '@playwright/test';
import { EditorApp, installTermsAccepted, readProofEvents } from '../helpers/app.js';
import { runVerifyCli } from '../helpers/verifyCli.js';
import {
  clickSettingsItem,
  loadClassPackage,
  typeIntoEveryTab,
  waitDialogClosed,
  waitDialogOpen,
} from '../helpers/scenario.js';

/**
 * #434-8 / #323: 設定メニューのリセット (`data-dialog="reset"`)。Esc と背景のクリックでは何も消さずに閉じ
 * (タブの id と中身が変わらない。件数はマウスのイベントで増えうるので見ない)、確定すると**現在のモードの
 * データだけ**を消し、削除の完了を待ってからパラメータ無しの URL で起動し直す。ダイアログには消えるモード名と
 * タブ数が出る (`#reset-scope[data-mode][data-tab-count]`)。class / assignment は確定後にタブ 0 本のウェルカム、
 * casual は ADR-0015 どおり新しい既定タブが 1 本できる (前のタブ id は残らない)。ほかのモードの session DB・
 * タブ・キーと、モード共通のキー (規約同意など) は残る。
 */

/** タブの id と中身 (件数を除く)。 */
async function tabState(app: EditorApp) {
  return (await app.snapshot()).tabs.map((t) => ({ id: t.id, content: t.content }));
}

async function openReset(app: EditorApp): Promise<void> {
  await clickSettingsItem(app.page, 'reset-btn');
  await waitDialogOpen(app, 'reset');
}

/**
 * 確定を押し、ページが読み直されるまで待つ。URL はパラメータ無しのまま変わらないので (遷移先が同じ URL)、
 * 古いページに付けた印が新しい文書から消えることで読み直しを見る。
 */
async function confirmResetAndWaitReload(app: EditorApp, pathPattern: RegExp): Promise<void> {
  const { page } = app;
  await page.evaluate(() => {
    (window as unknown as { __tcBeforeReset?: boolean }).__tcBeforeReset = true;
  });
  await page.locator('#reset-confirm-btn').click();
  await page.waitForFunction(() => !(window as unknown as { __tcBeforeReset?: boolean }).__tcBeforeReset);
  await expect(page).toHaveURL(pathPattern);
}

test('class: リセットは Esc と背景クリックでは何も消さずに閉じ、確定すると全タブが消えてウェルカムになる', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openModeFresh('class', { screenShare: 'share', waitReady: false });
  await waitDialogOpen(app, 'welcome');
  await loadClassPackage(app);
  // 全タブに書いておき、閉じただけのリセットで全タブの中身が保たれることを見る。
  await typeIntoEveryTab(app, 'int keep;');
  await app.waitForSynced();
  await app.expectConsistent();
  const before = await tabState(app);

  await openReset(app);
  await page.keyboard.press('Escape');
  await waitDialogClosed(app, 'reset');
  expect(await tabState(app)).toEqual(before);

  await openReset(app);
  // ダイアログの外側 (オーバーレイ自身) を押す。
  await page.locator('#reset-dialog').click({ position: { x: 5, y: 5 } });
  await waitDialogClosed(app, 'reset');
  expect(await tabState(app)).toEqual(before);
  await app.expectConsistent();

  // 閉じたあとも記録は壊れていない。
  await app.waitForSynced();
  const zipPath = await app.exportViaLogButton();
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);

  await openReset(app);
  // 確認ダイアログは、消えるモード名と、そのモードのタブ数を出す。
  await expect(page.locator('#reset-scope')).toHaveAttribute('data-mode', 'class');
  await expect(page.locator('#reset-scope')).toHaveAttribute('data-tab-count', String(before.length));
  await confirmResetAndWaitReload(app, /\/class$/);
  // 現在のモードを消して起動し直す。規約の同意はモード共通のキーなので残り、出るのは画面共有の選択から。
  await waitDialogOpen(app, 'screen-share-choice');
  await page.locator('.screen-share-choice-dialog [data-choice="share"]').click();
  await waitDialogOpen(app, 'welcome');
  await expect.poll(() => app.appState()).toBe('ready');
  expect(await app.tabs()).toEqual([]);
  await app.expectConsistent();
});

test('casual: リセットを確定すると前のタブは残らず、新しい既定タブで記録が始まって verify が pass する', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int old;');
  await app.waitForSynced();
  const oldIds = (await app.tabs()).map((t) => t.id);

  await openReset(app);
  // パラメータ無しの URL で起動し直す (リロードは削除の完了後)。
  await confirmResetAndWaitReload(app, /\/casual$/);
  await app.waitReady();
  await app.expectConsistent();
  const tabs = await app.snapshot();
  expect(tabs.tabs).toHaveLength(1);
  expect(oldIds).not.toContain(tabs.tabs[0]!.id);
  expect(tabs.tabs[0]!.content).toBe('');
  // 復旧ダイアログも出ない = 前のセッションの DB と sessionStorage が残っていない。
  expect(await app.openDialogs()).not.toContain('session-recovery');

  await app.typeCode('int fresh;');
  await app.waitForSynced();
  const zipPath = await app.exportCurrentTab();
  expect(JSON.stringify(await readProofEvents(zipPath))).not.toContain('old;');
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
});

test('casual のリセットは casual の session DB とキーだけを消し、assignment / exam のデータと規約同意は残す (#323)', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int old;');
  await app.waitForSynced();
  const casualIds = (await app.tabs()).map((t) => t.id);

  // assignment に実データ (問題タブ) を作る。
  await installTermsAccepted(page);
  await page.goto('/assignment');
  await waitDialogOpen(app, 'welcome');
  await loadClassPackage(app);
  await typeIntoEveryTab(app, 'int mine;');
  await app.waitForSynced();
  const assignmentTabs = (await app.tabs()).map((t) => t.id);
  expect(assignmentTabs.length).toBeGreaterThan(0);

  // exam と casual のモード別キーの代役を、実際のキー名で置く (exam はゲートの解錠が重いので DB とキーだけ)。
  await page.evaluate(async () => {
    localStorage.setItem('typedcode-exam-packages-exam', '{"marker":"exam"}');
    localStorage.setItem('typedcode-class-problems', '{"marker":"casual"}');
    sessionStorage.setItem('typedcode-tabs-exam', 'exam-tabs');
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('typedcode-session-exam', 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
    });
  });

  // casual へ戻って (casual の記録は復元される) リセットを開く。assignment のタブ数ではなく casual のタブ数が出る。
  await page.goto('/casual');
  await app.waitReady();
  await openReset(app);
  await expect(page.locator('#reset-scope')).toHaveAttribute('data-mode', 'casual');
  await expect(page.locator('#reset-scope')).toHaveAttribute('data-tab-count', String(casualIds.length));
  await confirmResetAndWaitReload(app, /\/casual$/);
  await app.waitReady();

  // casual は空のセッションで起動し直した (前のタブ・記録は無い)。
  const fresh = await app.snapshot();
  expect(fresh.tabs).toHaveLength(1);
  expect(casualIds).not.toContain(fresh.tabs[0]!.id);
  expect(fresh.tabs[0]!.content).toBe('');

  const after = await page.evaluate(async () => ({
    dbs: (await indexedDB.databases()).map((d) => d.name),
    local: {
      terms: localStorage.getItem('typedcode-terms-accepted'),
      examCache: localStorage.getItem('typedcode-exam-packages-exam'),
      casualClassCache: localStorage.getItem('typedcode-class-problems'),
    },
    session: {
      assignmentTabs: sessionStorage.getItem('typedcode-tabs-assignment'),
      examTabs: sessionStorage.getItem('typedcode-tabs-exam'),
    },
  }));
  // casual 用のキーは消え、assignment / exam のものと規約同意は残る。
  expect(after.local.casualClassCache).toBeNull();
  expect(after.local.examCache).toBe('{"marker":"exam"}');
  expect(after.local.terms).not.toBeNull();
  expect(after.session.examTabs).toBe('exam-tabs');
  expect(after.session.assignmentTabs).not.toBeNull();
  expect(after.dbs).toEqual(expect.arrayContaining(['typedcode-session-assignment', 'typedcode-session-exam']));

  // assignment のセッションは、ランディングの続きからバッジが元のタブ数のまま数える。
  const landing = await page.context().newPage();
  await landing.goto('/');
  await expect(landing.locator('.landing-card-mode[data-mode="assignment"] .session-badge')).toHaveAttribute(
    'data-tab-count',
    String(assignmentTabs.length)
  );
});
