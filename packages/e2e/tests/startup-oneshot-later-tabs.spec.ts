import { test, expect } from '@playwright/test';
import { EditorApp, readAllProofEvents, readProofEvents } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * #405: 起動時ワンショット (termsAccepted・初期 windowResize / networkStatusChange・environmentProbe・
 * screenShareOptOut) は、記録した時点にあるタブにしか載らなかった。後から作るタブには
 * EventRecorder がセッションのスナップショットを流し直す。ここでは proof のイベント列で
 * 「ちょうど 1 件載る (欠落も二重も無い)」ことを見る。class の round-trip は
 * screen-share-optout-confirm.spec.ts が持つ。
 */

const countOf = (events: { type: string }[], type: string) => events.filter((e) => e.type === type).length;

test('assignment: ウェルカム画面から作ったタブの proof に environmentProbe が 1 件載り、screenShareOptOut は載らない', async ({
  page,
}) => {
  const app = new EditorApp(page);
  // assignment は起動時にタブを作らずウェルカム画面になり、画面共有の選択も出さない (screenshots off)
  await app.openModeFresh('assignment', { waitReady: false });
  await page.locator('#welcome-new-file').click();
  await app.waitReady();
  await app.typeCode('int a = 1;\n');

  const zipPath = await app.exportCurrentTab();
  const events = await readProofEvents(zipPath);
  expect(countOf(events, 'environmentProbe'), 'environmentProbe replayed once to the tab created later').toBe(1);
  expect(countOf(events, 'screenShareOptOut'), 'assignment never opts out of screen sharing').toBe(0);

  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
});

test('casual: 起動時のタブと「新規ファイル」で足したタブのどちらの proof にも environmentProbe がちょうど 1 件載る', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('let first = 1;\n');
  await app.addTab();
  await app.typeCode('let second = 2;\n');

  const zipPath = await app.exportAllTabs();
  const proofs = await readAllProofEvents(zipPath);
  expect(proofs.size).toBe(2);
  for (const [entryName, events] of proofs) {
    expect(countOf(events, 'environmentProbe'), `environmentProbe exactly once in ${entryName}`).toBe(1);
  }

  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
});
