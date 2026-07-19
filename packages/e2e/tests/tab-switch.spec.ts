import { test, expect } from '@playwright/test';
import { EditorApp, readProofEvents } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * タブ切替 (フォーカス喪失→復帰) が proof に focusChange として記録されることを検証する。
 * VisibilityTracker → EventRecorder → proof の記録経路の回帰テスト。
 * (OS レベルの実タブ切替は headless で window blur が発火しないため、ブラウザが出すのと
 * 同じ blur/focus イベントを発火させて経路を検証する。)
 */
test('フォーカス喪失→復帰が focusChange として記録される', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int y = 2;');
  await app.simulateFocusLossAndReturn();
  await app.typeCode(' int z = 3;');

  const zipPath = await app.exportCurrentTab();
  const events = await readProofEvents(zipPath);
  const focusChanges = events.filter((e) => e.type === 'focusChange');

  // blur (focused:false) と focus (focused:true) の両方が記録されている。
  expect(focusChanges.some((e) => (e.data as { focused?: boolean })?.focused === false)).toBe(true);
  expect(focusChanges.some((e) => (e.data as { focused?: boolean })?.focused === true)).toBe(true);

  // チェーンは valid のまま。
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  // プロセス要約にフォーカス喪失が 1 件以上計上される。
  expect(result.stdout).toMatch(/[1-9]\d* focus loss/);
});
