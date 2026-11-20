import { test, expect, type Page } from '@playwright/test';
import { EditorApp, listZipEntries, readAllProofEvents } from '../helpers/app.js';
import { runVerifyCli } from '../helpers/verifyCli.js';
import {
  CLASS_POLICIES,
  capabilityContract,
  classPackageFile,
  contractOf,
  loadClassPackage,
  sampleClassPackage,
  typeIntoEveryTab,
  waitDialogOpen,
} from '../helpers/scenario.js';

/**
 * #645: `.tcclass` の方針 (policy) が、開いた入口 (`/class` `/assignment`) より優先して能力を決める。
 * 「教室で実施」の問題は `/assignment` で読んでも `/class` と同じ能力 (画面共有の選択が出る・全画面の記録・
 * export 前認証の best-effort) になり、「持ち帰り」の問題は `/class` で読んでも `/assignment` と同じ能力
 * (スクリーンショットを撮らない) になる。能力は状態契約 `html[data-cap-*]`、画面共有は `data-dialog` と ZIP で見る。
 */

const SCREEN_EVENTS = ['screenShareStart', 'screenShareOptOut', 'screenshotCapture'];

/**
 * ウィンドウのフォーカスを、スクリーンショットの tracker が 1 枚撮るまで外してから戻す (フォーカスを失ってから
 * 5 秒後に撮る。ScreenCaptureService の focusLostDelayMs)。headless では本物の blur が出ないので window に投げる
 * (idle.spec.ts と同じ)。tracker が動いていれば `screenshotCapture` と ZIP の screenshots/ が残り、止まっていれば残らない
 */
async function loseFocusUntilCaptured(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(7_000);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}

function packageWith(policy: (typeof CLASS_POLICIES)[keyof typeof CLASS_POLICIES]) {
  return classPackageFile({ ...sampleClassPackage(), policy });
}

test('assignment: 「教室で実施」の .tcclass を読むと画面共有の選択が出て、/class と同じ能力になる', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openModeFresh('assignment', { waitReady: false });
  await waitDialogOpen(app, 'welcome');
  expect(await capabilityContract(page)).toEqual(contractOf(CLASS_POLICIES.takeHome));

  await loadClassPackage(app, packageWith(CLASS_POLICIES.classroom), { screenShare: 'share' });
  expect(await capabilityContract(page)).toEqual(contractOf(CLASS_POLICIES.classroom));

  await typeIntoEveryTab(app, 'int x;');
  await loseFocusUntilCaptured(page);
  await app.waitForSynced();
  const zipPath = await app.exportViaLogButton();
  // 読み込み時に始めた画面共有で撮れている (起動時に画面共有を始めた /class と同じ)
  expect((await listZipEntries(zipPath)).some((name) => /screenshots?\//i.test(name))).toBe(true);
  const captures = [...(await readAllProofEvents(zipPath)).values()]
    .flat()
    .filter((e) => e.type === 'screenshotCapture');
  expect(captures.length).toBeGreaterThan(0);
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  await app.expectConsistent();
});

test('class: 「持ち帰り」の .tcclass を読むとスクリーンショットをやめ、/assignment と同じ能力で書き出す', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openModeFresh('class', { screenShare: 'share', waitReady: false });
  await waitDialogOpen(app, 'welcome');
  expect(await capabilityContract(page)).toEqual(contractOf(CLASS_POLICIES.classroom));

  await loadClassPackage(app, packageWith(CLASS_POLICIES.takeHome));
  expect(await capabilityContract(page)).toEqual(contractOf(CLASS_POLICIES.takeHome));
  // 自分で止めた画面共有をロック画面にしない
  expect(await app.openDialogs()).not.toContain('screen-capture-lock');

  await typeIntoEveryTab(app, 'int x;');
  await loseFocusUntilCaptured(page);
  await app.waitForSynced();
  const zipPath = await app.exportViaLogButton();
  expect((await listZipEntries(zipPath)).filter((name) => /screenshots?\//i.test(name))).toEqual([]);
  const screenEvents = [...(await readAllProofEvents(zipPath)).values()]
    .flat()
    .filter((e) => SCREEN_EVENTS.includes(e.type));
  expect(screenEvents).toEqual([]);
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  await app.expectConsistent();
});

test('class: 「持ち帰り」の .tcclass を読んだ後のリロードは画面共有の選択を出さず、/assignment と同じ能力で起動する', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openModeFresh('class', { screenShare: 'share', waitReady: false });
  await waitDialogOpen(app, 'welcome');
  await loadClassPackage(app, packageWith(CLASS_POLICIES.takeHome));
  await app.waitForSynced();

  await app.reloadAndResume();
  expect(await app.openDialogs()).not.toContain('screen-share-choice');
  expect(await capabilityContract(page)).toEqual(contractOf(CLASS_POLICIES.takeHome));
  await app.expectConsistent();
});
