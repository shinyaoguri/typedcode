import { test, expect } from '@playwright/test';
import { EditorApp } from './helpers/app.js';
import { blockTurnstileScript } from './helpers/faults.js';

/**
 * Turnstile のスクリプト (`challenges.cloudflare.com`) が読めない環境 (#435): casual は起動時の
 * 認証に失敗しても既定タブで編集を始められる (TabManager は認証失敗でもタブ作成を続ける)。
 *
 * export は assert しない: casual の export 前認証は、Turnstile が読めなければ設計どおり中止される
 * (editor AGENTS.md の不変条件 6・`ProofExporter`)。これを変えるかどうかは #444 の判断待ち。
 *
 * 注入は abort にする (hang だと Turnstile の読み込み待ちで起動が 30 秒を超える)。
 */
test('casual: Turnstile のスクリプトが読めなくても編集を始められる (export は #444 の判断待ち)', async ({ page }) => {
  const blocked = await blockTurnstileScript(page);
  const app = new EditorApp(page);
  await app.openCasualFresh();

  // 注入が空振りしていない (起動時の認証が Turnstile のスクリプトを取りに行った)。
  expect(blocked.calls()).toBeGreaterThan(0);
  await expect.poll(() => app.appState()).toBe('ready');

  const before = await app.eventCount();
  await app.typeCode('int t = 1;');
  await app.expectConsistent();
  expect(await app.eventCount()).toBeGreaterThan(before);
  expect((await app.snapshot()).tabs[0]!.content).toBe('int t = 1;');
});
