import { test, expect } from '@playwright/test';
import { BOOT_TIMEOUT_MS, EditorApp, readProofEvents, readZipEntryText } from './helpers/app.js';
import { allPassed, runVerifyCliWithResult } from './helpers/verifyCli.js';

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

  const zipPath = await app.exportAllTabs();

  // チェーンは復元をまたいでも valid。
  const result = runVerifyCliWithResult(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  expect(allPassed(result.results)).toBe(true);

  // sessionResumed イベントが記録されている (復元の痕跡)。
  const events = await readProofEvents(zipPath);
  expect(events.some((e) => e.type === 'sessionResumed')).toBe(true);
});

/**
 * 復元時に switchTab が合成の「null → 最初のタブ」切替を足し、リロードのたびに
 * tab-switches.json へ蓄積していた (#284)。復元中は復元済みの履歴を使うので足さない。
 * 最初のタブを開いたときの 1 件 (fromTabId: null) だけが残る。
 * 注: export は全タブの ZIP だけで (#779)、tab-switches.json は切替の記録が 1 件でもあれば入る。
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

/** export した ZIP の tab-switches.json の from / to の並び (timestamp は見ない) */
async function tabSwitchPairs(zipPath: string): Promise<{ fromTabId: string | null; toTabId: string }[]> {
  const switches = JSON.parse(await readZipEntryText(zipPath, 'tab-switches.json')) as Array<{
    fromTabId: string | null;
    toTabId: string;
  }>;
  return switches.map(({ fromTabId, toTabId }) => ({ fromTabId, toTabId }));
}

/**
 * 最後のタブを閉じてからリロードすると、開いたタブが無いので新しいセッションになる (#891)。タブ切替の履歴は
 * セッション単位なので、前のセッションの切替 (閉じたタブへの切替) を持ち越さない。以前はリロード (sessionStorage
 * 経路) だけが持ち越し、ブラウザのタブを閉じて再開 (IndexedDB 経路。今のセッションの分だけが戻る) した後の export と
 * 食い違っていた (nightly の model-based E2E が見つけた列: 閉じる → リロード → 閉じて再開 → export)。
 */
test('#891 最後のタブを閉じてからリロードすると、tab-switches.json に前のセッションの切替が入らず、閉じて再開しても同じ', async ({
  page,
  context,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  const [closed] = await app.tabs();
  await app.requestCloseTab(closed!.id);
  await app.answerCloseTab('confirm');

  // タブ 0 本で起動すると casual は既定タブを 1 本開く (ADR-0015)
  await app.reloadAndResume();
  const opened = await app.tabs();
  expect(opened).toHaveLength(1);
  const expected = [{ fromTabId: null, toTabId: opened[0]!.id }];
  expect(await tabSwitchPairs(await app.exportAllTabs())).toEqual(expected);

  // ブラウザのタブを閉じて、復旧ダイアログから再開する (IndexedDB 経路)
  await app.waitForSynced();
  await page.close();
  const page2 = await context.newPage();
  const app2 = new EditorApp(page2);
  await page2.goto('/casual');
  const resume = page2.locator('#session-resume-btn');
  await resume.waitFor({ state: 'visible', timeout: 15_000 });
  await resume.click();
  await page2.locator('.monaco-editor .view-lines').first().waitFor({ state: 'visible', timeout: BOOT_TIMEOUT_MS });
  await expect.poll(() => app2.eventCount(), { timeout: 30_000 }).toBeGreaterThan(0);

  expect(await tabSwitchPairs(await app2.exportAllTabs())).toEqual(expected);
});
