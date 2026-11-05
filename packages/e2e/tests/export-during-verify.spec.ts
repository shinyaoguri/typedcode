import { test, expect } from '@playwright/test';
import { EditorApp } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * #565: 現在のタブの export は、ZIP をダウンロードさせた後も、ダウンロード後の自己検証が終わるまで
 * 次の export を受け付けず、その間に押した export は何も出さずに無視されていた。
 *
 * 検証の長さに頼らず決定的に見るため、1 回目のダウンロードのアンカー (`a[download]`) が DOM に入った
 * 瞬間 (= 1 回目の自己検証が終わる前) に、ページの中から 2 回目の「現在のタブ」の export を押す。
 * 2 回目は 1 回目の検証の途中で同じ proof に記録する (reflectionNote / preExportAttestation) ので、
 * その proof が verify-cli で pass することもあわせて見る。
 *
 * #586: 自己検証は ZIP に入れた proof.json に `verifyProofFile` (fast) をかけた結論。実エディタの proof
 * (dev 鍵の registry を含む) で、2 回の export の自己検証がどちらも `valid: true` を出すことも見る。
 */

/** 2 回目の export のセルフレビューが出るまでの上限。押した export が無視されるとここで落ちる。 */
const SECOND_EXPORT_START_TIMEOUT_MS = 30_000;

test('casual: 1 回目の export の検証が終わる前に押した 2 回目の export も ZIP を出し、検証に通る (#565)', async ({
  page,
}) => {
  // 自己検証の結論は ProofExporter.verifyAfterDownload が `[TypedCode] Verification result:` と一緒に出す
  const verificationResults: Array<{ valid?: unknown }> = [];
  page.on('console', (msg) => {
    if (!msg.text().startsWith('[TypedCode] Verification result:')) return;
    const result = msg.args()[1];
    if (!result) return;
    void result.jsonValue().then((value: { valid?: unknown }) => verificationResults.push(value));
  });

  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int total = 0;\nfor (int i = 0; i < 10; i++) {\ntotal += i;\n}\n');
  await app.waitForSynced();

  await page.evaluate(() => {
    const w = window as unknown as { __tc565SecondClicked?: boolean };
    const observer = new MutationObserver((records) => {
      const added = records.some((r) =>
        [...r.addedNodes].some((n) => n instanceof HTMLAnchorElement && n.hasAttribute('download'))
      );
      if (!added || w.__tc565SecondClicked) return;
      w.__tc565SecondClicked = true;
      observer.disconnect();
      document.getElementById('export-current-tab-btn')?.click();
    });
    observer.observe(document.body, { childList: true });
  });

  await app.exportCurrentTab();
  expect(
    await page.evaluate(() => (window as unknown as { __tc565SecondClicked?: boolean }).__tc565SecondClicked)
  ).toBe(true);

  // 2 回目: セルフレビューが出る (= export が始まった) → 続行 → ダウンロード。
  const secondDownload = page.waitForEvent('download', { timeout: 90_000 });
  // セルフレビューが出ずに落ちたとき、こちらの待ちが「Test ended」で二重に報告されないようにする。
  secondDownload.catch(() => {});
  const proceed = page.locator('.self-review-btn-proceed');
  await proceed.waitFor({ state: 'visible', timeout: SECOND_EXPORT_START_TIMEOUT_MS });
  await proceed.click();
  const download = await secondDownload;
  const zipPath = join(mkdtempSync(join(tmpdir(), 'tc-e2e-dl-')), download.suggestedFilename());
  await download.saveAs(zipPath);

  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  await expect.poll(() => verificationResults.length, { timeout: 30_000 }).toBe(2);
  expect(verificationResults.map((r) => r.valid)).toEqual([true, true]);
  await app.expectConsistent();
});
