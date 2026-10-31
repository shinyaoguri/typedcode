import { test, expect } from '@playwright/test';
import { EditorApp, readProofEvents, readZipEntryText } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * リロード復元: 編集途中でリロードしても IndexedDB / sessionStorage からセッションが復元され、
 * ハッシュチェーンが途切れず継続することを検証する (export → verify-cli が pass)。
 * 永続化と復元時のチェーン整合 (editor 不変条件 #5) の回帰テスト。
 */
test('リロード後もセッションが復元され、チェーンが途切れず検証が pass する', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();

  await app.typeCode('int a = 1;\n');
  const beforeCount = await app.eventCount();
  expect(beforeCount).toBeGreaterThan(1);

  await app.reloadAndResume();

  // 復元されたエディタに前回の内容が残っている。
  expect(await app.editorValue()).toContain('int a = 1;');
  // 記録は復元後も継続 (リセットされていない)。
  expect(await app.eventCount()).toBeGreaterThanOrEqual(beforeCount);

  // 復元後にさらに打鍵してチェーンを伸ばす。
  await app.typeCode('int b = 2;\n');
  expect(await app.editorValue()).toContain('int b = 2;');

  const zipPath = await app.exportCurrentTab();

  // チェーンは復元をまたいでも valid。
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  expect(result.stdout).toContain('Verification PASSED');

  // sessionResumed イベントが記録されている (復元の痕跡)。
  const events = await readProofEvents(zipPath);
  expect(events.some((e) => e.type === 'sessionResumed')).toBe(true);
});

/**
 * 復元時に switchTab が合成の「null → 最初のタブ」切替を足し、リロードのたびに
 * tab-switches.json へ蓄積していた (#284)。復元中は復元済みの履歴を使うので足さない。
 * 最初のタブを開いたときの 1 件 (fromTabId: null) だけが残る。
 * 注: 単一タブ export の ZIP には tab-switches.json が入らないので、全タブ export で読む。
 */
test('リロードを重ねても tab-switches.json に fromTabId: null の合成切替が蓄積しない', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int a = 1;\n');

  await app.reloadAndResume();
  await app.typeCode('int b = 2;\n');
  await app.reloadAndResume();

  const zipPath = await app.exportAllTabs();
  const switches = JSON.parse(await readZipEntryText(zipPath, 'tab-switches.json')) as Array<{
    fromTabId: string | null;
  }>;

  expect(switches.filter((s) => s.fromTabId === null)).toHaveLength(1);
});
