import { test, expect } from '@playwright/test';
import { EditorApp, readProofEvents } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * #374: class で画面共有の選択ダイアログに「共有しない (optOut)」を選ぶと、続けて確認ダイアログ
 * (`.screen-share-optout-confirm-dialog`) が出る。`openModeFresh({ screenShare: 'optOut' })` が
 * それも閉じて先へ進み、編集 → export → verify-cli 検証が pass する round-trip を固定する。
 *
 * class は起動時にタブを作らずウェルカム画面になるので、`waitReady: false` で開いて
 * `#welcome-new-file` でタブを作る。起動時ワンショット (screenShareOptOut・environmentProbe・
 * termsAccepted) が、後から作ったこのタブの proof に 1 件ずつ載ることも固定する (#405)。
 */
test('class: 画面共有を optOut で開始しても確認ダイアログを閉じて編集→export→CLI 検証が pass する', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openModeFresh('class', { screenShare: 'optOut', waitReady: false });
  await page.locator('#welcome-new-file').click();
  await app.waitReady();
  await app.typeCode('int o = 1;\n');
  expect(await app.editorValue()).toContain('int o = 1;');

  const zipPath = await app.exportCurrentTab();

  // optOut なので画面共有は始まっていない。
  const events = await readProofEvents(zipPath);
  expect(
    events.some((e) => e.type === 'screenShareStart'),
    'screenShareStart is not recorded when opting out'
  ).toBe(false);

  // #405: class は起動時にタブが無いので、起動時ワンショットは後から作ったこのタブへ流し直される。
  // 起動時の 1 回分だけが載り、二重にならない。
  const countOf = (type: string) => events.filter((e) => e.type === type).length;
  expect(countOf('screenShareOptOut'), 'screenShareOptOut replayed once to the tab created later').toBe(1);
  expect(countOf('environmentProbe'), 'environmentProbe replayed once to the tab created later').toBe(1);
  expect(countOf('termsAccepted'), 'termsAccepted replayed once to the tab created later').toBe(1);

  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  expect(result.stdout).toContain('Verification PASSED');
});
