import { test, expect } from '@playwright/test';
import { EditorApp, readProofEvents } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * #374: class で画面共有の選択ダイアログに「共有しない (optOut)」を選ぶと、続けて確認ダイアログ
 * (`.screen-share-optout-confirm-dialog`) が出る。`openModeFresh({ screenShare: 'optOut' })` が
 * それも閉じて先へ進み、編集 → export → verify-cli 検証が pass する round-trip を固定する。
 *
 * class は起動時にタブを作らずウェルカム画面になるので、`waitReady: false` で開いて
 * `#welcome-new-file` でタブを作る。
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
  // 注: `screenShareOptOut` の記録は assert しない。class は起動時にタブが無く、起動時ワンショットが
  // タブ未作成でドロップされて proof に載らない (#405)。#405 が直ったらここに足す。
  const events = await readProofEvents(zipPath);
  expect(
    events.some((e) => e.type === 'screenShareStart'),
    'screenShareStart is not recorded when opting out'
  ).toBe(false);

  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  expect(result.stdout).toContain('Verification PASSED');
});
