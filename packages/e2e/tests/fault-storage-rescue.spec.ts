import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { EditorApp, listZipEntries, readZipEntryText } from './helpers/app.js';
import { loadExamFixture } from './helpers/examFixture.js';
import { injectQuotaExceeded, quotaFailureCount } from './helpers/faults.js';

/**
 * 救出ボタン (#544 / #300 の受け入れ条件 4)。IndexedDB と sessionStorage の書き込みがどちらも失敗して
 * 同期状態が `failed` になっても、救出ボタンでメモリ上の最新のコードを `RESCUE_TC<ts>.zip` として持ち出せる。
 *
 * - `src/` の各ファイルが、エディタの内容 (`__tcTestSnapshot` の content) と一致する
 * - 証明ではない: `*_proof.json` が無く、manifest (`rescue-manifest.json`) が `notAProof: true` でタブ数が合う
 * - casual は左の DL メニュー (`#rescue-download-btn`)、exam は問題パネル (`#problem-rescue-btn`。exam は
 *   DL メニューを隠す) から出す
 *
 * 救出 ZIP は verify-cli に通さない (検証できるものではないことが仕様。証明の export は fault-storage.spec.ts)。
 */

interface RescueManifest {
  schema: string;
  notAProof: boolean;
  mode: string;
  tabs: { id: string; source: string | null; error: string | null }[];
}

/** 救出ボタンを押してダウンロードを保存し、そのパスを返す */
async function rescue(page: Page, route: 'downloadMenu' | 'problemPanel'): Promise<string> {
  const download = page.waitForEvent('download', { timeout: 30_000 });
  if (route === 'downloadMenu') {
    await page.locator('#download-menu-btn').click();
    await page.locator('#rescue-download-btn').click();
  } else {
    await page.locator('#problem-rescue-btn').click();
  }
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^RESCUE_TC\d{10}\.zip$/);
  const dest = join(mkdtempSync(join(tmpdir(), 'tc-e2e-rescue-')), file.suggestedFilename());
  await file.saveAs(dest);
  return dest;
}

/** 救出 ZIP が証明を含まず、`src/` がエディタの各タブの内容と一致することを確かめる */
async function expectRescueMatchesEditor(app: EditorApp, zipPath: string, mode: string): Promise<void> {
  const entries = await listZipEntries(zipPath);
  expect(entries.filter((e) => e.endsWith('_proof.json'))).toEqual([]);

  const manifest = JSON.parse(await readZipEntryText(zipPath, 'rescue-manifest.json')) as RescueManifest;
  expect(manifest).toMatchObject({ schema: 'typedcode-rescue/2', notAProof: true, mode });

  const snapshot = await app.snapshot();
  expect(manifest.tabs.map((t) => t.id)).toEqual(snapshot.tabs.map((t) => t.id));
  for (const tab of snapshot.tabs) {
    const rescued = manifest.tabs.find((t) => t.id === tab.id);
    expect(rescued?.error ?? null, `tab ${tab.filename} was read without errors`).toBeNull();
    expect(rescued?.source, `tab ${tab.filename} has a source in the rescue ZIP`).toMatch(/^src\//);
    expect(await readZipEntryText(zipPath, rescued!.source!), `src of ${tab.filename}`).toBe(tab.content);
  }
}

test('#300 保存先が全滅して failed でも、救出ボタンで 2 タブのコードを ZIP で持ち出せる (casual)', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int first = 1;\n');
  await app.addTab();
  await app.typeCode('int second = 2;\n');
  await app.waitForSynced();

  await injectQuotaExceeded(page, 'idbAndSessionStorage');
  // 保存できなくなった後に打ったコードも救出に入る (メモリ上の最新から作る)
  await app.typeCode('int third = 3;\n');
  await expect(page.locator('#sync-status-item')).toHaveAttribute('data-state', 'failed', { timeout: 15_000 });
  expect(await quotaFailureCount(page)).toBeGreaterThan(0);

  const zipPath = await rescue(page, 'downloadMenu');

  await expectRescueMatchesEditor(app, zipPath, 'casual');
  expect((await app.snapshot()).tabs.map((t) => t.content).join('')).toContain('int third = 3;');
});

const fixture = loadExamFixture();

test('#300 保存先が全滅して failed でも、exam は問題パネルの救出ボタンでコードを ZIP で持ち出せる', async ({
  page,
}) => {
  // CI で fixture が無いのは setup の配線の壊れ。skip で緑にせず落とす (exam-roundtrip.spec.ts と同じ扱い)
  if (!fixture) {
    if (process.env.CI)
      throw new Error('exam fixture is missing: `npm run setup -w @typedcode/e2e` did not generate it');
    test.skip(true, 'exam fixture 未生成 (npm run setup -w @typedcode/e2e で作る)');
    return;
  }

  const app = new EditorApp(page);
  await app.openModeFresh('exam', { screenShare: 'share', waitReady: false });
  await expect.poll(() => app.appState()).toBe('gate');
  await app.unlockExam(fixture.packagePath, fixture.code);
  await app.typeCode('int main(void) {\n');
  await app.waitForSynced();

  await injectQuotaExceeded(page, 'idbAndSessionStorage');
  await app.typeCode('  return 0;\n}\n');
  await expect(page.locator('#sync-status-item')).toHaveAttribute('data-state', 'failed', { timeout: 15_000 });
  expect(await quotaFailureCount(page)).toBeGreaterThan(0);

  const zipPath = await rescue(page, 'problemPanel');

  await expectRescueMatchesEditor(app, zipPath, 'exam');
});
