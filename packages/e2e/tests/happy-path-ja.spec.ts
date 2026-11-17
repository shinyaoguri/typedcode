import { test, expect } from '@playwright/test';
import { EditorApp } from './helpers/app.js';
import { runVerifyCliWithVerdicts } from './helpers/verifyCli.js';

/**
 * happy path を ja の UI で通す (#597)。通常の E2E は config (browser-env.ts) で en-US・UTC に固定して
 * いるので、利用者の既定である ja の UI と JST の時刻は、この 1 本が代表して通す。全 spec を倍にしないよう
 * project は増やさず、spec 側の `test.use` で上書きする。
 *
 * ja の UI になっていることは `<html lang>` で見る (shared の domUpdater が I18nService の locale を書く。
 * localStorage が空の新しい context なので、検出は navigator.language → 既定の順に落ちる)。翻訳テキストは
 * 読まない (AGENTS.md)。検証は fast (不変条件 4。full は happy-path.spec.ts の 1 本だけ)。
 */
test.use({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });

test('casual (ja-JP / Asia/Tokyo): ja の UI で打鍵→export→CLI 検証 (fast) が pass する', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();

  // ja の UI で起動している (en-US なら domUpdater が `en` を書く)。
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');

  const initialCount = await app.eventCount();
  const code = 'int f() {\n  return 0;\n}\n';
  await app.typeCode(code);

  expect(await app.editorValue()).toContain('int f()');
  expect(await app.eventCount()).toBeGreaterThan(initialCount);

  const zipPath = await app.exportAllTabs();
  const result = runVerifyCliWithVerdicts(zipPath, ['--mode', 'fast']);

  expect(result.passed, result.stdout + result.stderr).toBe(true);
  expect(result.verdicts.length).toBeGreaterThan(0);
  expect(result.verdicts[0]!.valid).toBe(true);
  expect(result.verdicts[0]!.assurance.provenance.pureTyping).toBe(true);
});
