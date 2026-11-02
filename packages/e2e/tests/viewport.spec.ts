import { test, expect } from '@playwright/test';
import { EditorApp, listProofEntries } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * 狭いビューポート (#435): タブレット縦 (768×1024) とスマートフォン相当 (480×800) でも、
 * タブの追加 → 打鍵 → 全タブ export が操作でき、DOM の状態契約が内部状態と一致し、proof が検証に通る。
 */
for (const size of [
  { width: 768, height: 1024 },
  { width: 480, height: 800 },
]) {
  test(`${size.width}×${size.height} でもタブの追加 → 打鍵 → export ができ、検証が pass する`, async ({ page }) => {
    await page.setViewportSize(size);
    const app = new EditorApp(page);
    await app.openCasualFresh();
    await app.typeCode('int a = 1;');

    await app.addTab();
    await app.typeCode('int b = 2;');
    await app.expectConsistent();
    expect((await app.snapshot()).tabs.map((t) => t.content)).toEqual(['int a = 1;', 'int b = 2;']);

    await app.waitForSynced();
    const zipPath = await app.exportAllTabs();
    await app.expectConsistent();
    expect(await listProofEntries(zipPath)).toHaveLength(2);

    const result = runVerifyCli(zipPath, ['--mode', 'fast']);
    expect(result.passed, result.stdout + result.stderr).toBe(true);
  });
}
