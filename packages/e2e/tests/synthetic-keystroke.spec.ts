import { test, expect } from '@playwright/test';
import { EditorApp, readProofEvents } from './helpers/app.js';
import { runVerifyCliWithAnalysis } from './helpers/verifyCli.js';

/**
 * 合成打鍵の検出 (ADR-0018): スクリプトが dispatchEvent で注入した KeyboardEvent は
 * ブラウザにより isTrusted=false になる。KeystrokeTracker はこれを data.isTrusted=false
 * として記録し、automationAnalyzer が数える。
 *
 * このテストは「本物の信頼打鍵 (Playwright の CDP 入力は isTrusted=true)」と「合成打鍵」を
 * 同一セッションに混ぜ、後者だけ isTrusted=false が付くことを実ブラウザで実証する
 * (単体テストでは保証できなかった「ブラウザが本当に false を付ける」性質)。
 */
test('合成打鍵には isTrusted=false が付き、信頼打鍵には付かない (ADR-0018)', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('ab'); // 信頼打鍵 (CDP 経由 = isTrusted true)
  await app.injectSyntheticKeystroke('x'); // 合成打鍵 (dispatchEvent = isTrusted false)

  const zipPath = await app.exportCurrentTab();
  const events = await readProofEvents(zipPath);
  const keyEvents = events.filter((e) => e.type === 'keyDown' || e.type === 'keyUp');

  const isTrusted = (e: (typeof keyEvents)[number]): boolean | undefined =>
    (e.data as { isTrusted?: boolean })?.isTrusted;

  // 合成打鍵: isTrusted=false が載っている。
  expect(
    keyEvents.some((e) => isTrusted(e) === false),
    'synthetic key must carry isTrusted=false'
  ).toBe(true);
  // 信頼打鍵: isTrusted フィールドを省略する (hash バイト不変のため)。false が付かない。
  const realKeys = keyEvents.filter((e) => (e.data as { key?: string })?.key === 'a');
  expect(realKeys.length).toBeGreaterThan(0);
  expect(realKeys.every((e) => isTrusted(e) !== false)).toBe(true);

  // チェーンは valid。automation 分析が合成打鍵を拾う。
  const result = runVerifyCliWithAnalysis(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  expect(result.stdout.toLowerCase()).toContain('automation');
});
