import { test, expect } from '@playwright/test';
import { EditorApp, writeZipVariant } from './helpers/app.js';
import { VerifyWebApp, proofNames, typeAndExport } from './helpers/verifyWeb.js';

/**
 * verify Web を通す往復 E2E (#346 PR 3 / 分割は #533): editor で打鍵 → export した ZIP を検証 Web に入れ、
 * 判定を **data-* の状態契約** (verify/AGENTS.md) で読む。翻訳テキスト・色クラスは見ない。
 *
 * このファイルはタブ・サイドバー・結果パネル・チャートタブの UI の系統。タブを閉じたあとの active の一致や、チャートタブが押せることを
 * data-* の状態契約で見る (翻訳テキスト・見た目は読まない)。
 * 検証はすべて fast (`?mode=fast` / `--mode fast`)。PoSW full は happy-path の 1 本だけ (不変条件 4)。
 * 同じ系統の兄弟: verify-web-parity / verify-web-submission / verify-web-ui (1 ファイルが CI で Slow Test の閾値 5 分を超えたため分割。共通の手順は helpers/verifyWeb.ts)。
 */

// #281: アクティブなタブを閉じたあと、TabBar / サイドバー / 結果パネルの active が食い違い、
// 閉じたはずのタブの判定が残る (別の提出物の判定を読む事故)。
test('アクティブなタブを閉じても、タブ・サイドバー・結果パネルの active が一致する (#281)', async ({ page }) => {
  const zipPath = await typeAndExport(new EditorApp(page));
  const zips = [
    await writeZipVariant(zipPath, { renameProof: 'a', outName: 'a.zip' }),
    await writeZipVariant(zipPath, { renameProof: 'b', outName: 'b.zip' }),
    await writeZipVariant(zipPath, { renameProof: 'c', outName: 'c.zip' }),
  ];
  const web = new VerifyWebApp(page);
  await web.open('fast');
  await web.load(zips);

  // a → b → c の順に開く (最後に開いた c がアクティブ)。
  for (const f of ['a_proof.json', 'b_proof.json', 'c_proof.json']) await web.selectFile(f);
  await expect.poll(() => web.activeTabFilename()).toBe('c_proof.json');
  await expect.poll(() => web.displayedFilename()).toBe('c_proof.json');

  await web.closeTab('c_proof.json');

  // 閉じた c ではなく、残ったタブのどれかに 3 か所そろって移っている。
  await expect
    .poll(async () => ({
      tab: await web.activeTabFilename(),
      sidebar: await web.activeFileItemFilename(),
      displayed: await web.displayedFilename(),
    }))
    .toMatchObject({ tab: expect.stringMatching(/^[ab]_proof\.json$/) });
  const after = {
    tab: await web.activeTabFilename(),
    sidebar: await web.activeFileItemFilename(),
    displayed: await web.displayedFilename(),
  };
  expect(after.sidebar, JSON.stringify(after)).toBe(after.tab);
  expect(after.displayed, JSON.stringify(after)).toBe(after.tab);
  expect(after.tab, JSON.stringify(after)).not.toBe('c_proof.json');
});

// #387: 最後の 1 枚を閉じても Sidebar の active が閉じたファイルを指したまま残る。
test('最後のタブを閉じると、サイドバーにもアクティブな行が残らない (#387)', async ({ page }) => {
  const zipPath = await typeAndExport(new EditorApp(page));
  const zip = await writeZipVariant(zipPath, { renameProof: 'a', outName: 'a.zip' });
  const web = new VerifyWebApp(page);
  await web.open('fast');
  await web.load([zip]);

  await web.selectFile('a_proof.json');
  await expect.poll(() => web.activeTabFilename()).toBe('a_proof.json');
  await expect.poll(() => web.activeFileItemFilename()).toBe('a_proof.json');

  await web.closeTab('a_proof.json');

  await expect.poll(() => web.activeTabFilename()).toBeNull();
  await expect.poll(() => web.activeFileItemFilename()).toBeNull();
});

// #395: 結果を表示した後、1280x800 でチャートのタブ (タイムライン等) が結果カードに覆われて押せなかった。
// `.result-left-panel` は縦 flex で、`overflow: hidden` の `.chart-section` が高さ不足のとき 2px まで
// 縮み、タブの位置に `#result-cards` が重なっていた。force なしのクリックが通ることを見る。
test.describe('結果パネルのチャートタブ (1280x800)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('結果表示後にタイムライン・マウス軌跡のタブを force なしで押して切り替えられる (#395)', async ({ page }) => {
    const zipPath = await typeAndExport(new EditorApp(page));
    const [proof] = await proofNames(zipPath);

    const web = new VerifyWebApp(page);
    await web.open('fast');
    await web.load([zipPath]);
    await web.readVerdict(proof!);

    expect(await web.activeChartTab(), '初期は統合チャート').toBe('integrated');
    expect(await web.activeChartPanel()).toBe('integrated');

    await web.clickChartTab('timeline');
    await expect.poll(() => web.activeChartTab()).toBe('timeline');
    expect(await web.activeChartPanel(), 'タブに対応するパネルが表示される').toBe('timeline');

    await web.clickChartTab('mouse');
    await expect.poll(() => web.activeChartTab()).toBe('mouse');
    expect(await web.activeChartPanel()).toBe('mouse');
  });
});
