import { test, expect } from '@playwright/test';
import { EditorApp, readProofEvents, readProofJson } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * タブ閉じ復旧 (#130 回帰): ブラウザタブを閉じると sessionStorage は消えるが IndexedDB は
 * 残る。再訪時に SessionRecoveryDialog から「再開」した場合も sessionStartToken (ADR-0017)
 * が引き継がれ、アンカー済みセッションの proof が root 不一致にならず検証が pass する。
 * リロード復元 (sessionStorage 経路 = reload-recovery.spec) と対になる IndexedDB 経路のテスト。
 *
 * 検証は `--mode fast`: #130 の破綻は root (initial event chain hash) 不一致であり
 * PoSW 再計算とは無関係なので fast で検出できる (CI 時間の節約)。
 */
test('タブを閉じて復旧ダイアログから再開しても root アンカーが保持され検証が pass する', async ({ page, context }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();

  await app.typeCode('int a = 1;\n');
  await app.waitForSynced();

  // ブラウザタブを閉じる = sessionStorage 消滅・IndexedDB は残る。
  await page.close();

  // 再訪 (?reset なし)。sessionStorage が無いので SessionRecoveryDialog が出るはず。
  const page2 = await context.newPage();
  const app2 = new EditorApp(page2);
  await page2.goto('/casual');

  // この経路では復旧ダイアログの出現自体がテストの前提 (出なければ復旧経路を通っていない)。
  const resume = page2.locator('#session-resume-btn');
  await resume.waitFor({ state: 'visible', timeout: 15_000 });
  await resume.click();

  await page2.locator('.monaco-editor .view-lines').first().waitFor({ state: 'visible' });
  await expect.poll(() => app2.eventCount(), { timeout: 30_000 }).toBeGreaterThan(0);

  // 復元されたエディタに前回の内容が残っている。
  expect(await app2.editorValue()).toContain('int a = 1;');

  // 復旧後にさらに打鍵してチェーンを伸ばし、export する。
  await app2.typeCode('int b = 2;\n');
  await app2.waitForSynced();
  const zipPath = await app2.exportCurrentTab();

  // #130 の核心: アンカー済みセッションの token が IndexedDB 復旧をまたいで proof に残る。
  const proof = await readProofJson(zipPath);
  expect(proof.rootAnchored, 'sessionStartToken must survive IndexedDB recovery').toBe(true);
  expect(proof.sessionStartToken, 'proof must carry the session start token').toBeTruthy();

  // チェーンは復旧をまたいでも valid (root 不一致なら fast でも即 fail する)。
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  expect(result.stdout).toContain('Verification PASSED');

  // sessionResumed イベントが記録されている (復旧の痕跡)。
  const events = await readProofEvents(zipPath);
  expect(events.some((e) => e.type === 'sessionResumed')).toBe(true);
});
