import { test, expect } from '@playwright/test';
import { EditorApp } from '../helpers/app.js';
import { runVerifyCli } from '../helpers/verifyCli.js';

/**
 * #434-6: ステータスバーの `#language-selector` の 8 言語を 1 つのタブで順に切り替え、それぞれで打鍵する。
 * 言語の変更自体は proof に記録しないので、切り替えるたびに打鍵が記録され (件数が増え)、DOM と内部状態が
 * 一致し続けることを見て、最後の export が verify-cli (fast) で pass することで判定する。
 * CI 時間を抑えるため 1 タブで回す。打つのは Monaco の自動補完で括弧が閉じられない単純な語。
 *
 * 件数は 100 未満に収める: 100 件目で記録される contentSnapshot が表示に反映されず、DOM の件数が 1 件
 * 遅れたまま止まる既知のバグ (#448) を踏まないため (再現は下の fixme)。
 */
const LANGUAGES = ['c', 'cpp', 'javascript', 'typescript', 'python', 'html', 'css', 'plaintext'];

test('8 つの言語に順に切り替えてそれぞれで打鍵しても記録が続き、export が verify (fast) で pass する', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  const [tab] = await app.tabs();
  let lastCount = await app.eventCount();

  for (const [i, language] of LANGUAGES.entries()) {
    await app.setLanguage(language);
    await app.typeCode(`w${i}`);
    await app.expectConsistent();
    const current = (await app.tabs())[0]!;
    expect(current).toMatchObject({ id: tab!.id, language });
    const count = await app.eventCount();
    expect(count, `typing in ${language} is recorded`).toBeGreaterThan(lastCount);
    lastCount = count;
  }

  expect(lastCount, 'stay below the 100th event (#448)').toBeLessThan(100);
  await app.waitForSynced();
  const zipPath = await app.exportCurrentTab();
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  await app.expectConsistent();
});

test.fixme('#448 100 件目を超えて打鍵を止めると、contentSnapshot まで含めて DOM の件数・ハッシュが内部状態に追いつく', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  // 1 文字あたり keyDown / contentChange / cursor / selection / keyUp でおよそ 5 件。100 件を確実に越える。
  for (let i = 0; i < 4; i++) {
    await app.typeCode('abcdefgh ');
    await app.expectConsistent();
  }
  expect(await app.eventCount()).toBeGreaterThan(100);
});
