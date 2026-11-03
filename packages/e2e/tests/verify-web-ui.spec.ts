import { test, expect } from '@playwright/test';
import { EditorApp, writeZipVariant } from './helpers/app.js';
import { VerifyWebApp, proofNames, typeAndExport } from './helpers/verifyWeb.js';

/**
 * verify Web を通す往復 E2E (#346 PR 3 / 分割は #533): editor で打鍵 → export した ZIP を検証 Web に入れ、
 * 判定を **data-* の状態契約** (verify/AGENTS.md) で読む。翻訳テキスト・色クラスは見ない。
 *
 * このファイルはタブ・サイドバー・結果パネル・チャートタブの UI の系統。タブを閉じたあとの active の一致や、チャートタブが押せることを
 * data-* の状態契約で見る (翻訳テキスト・見た目は読まない)。
 * 検証は fast (`?mode=fast` / `--mode fast`)。PoSW full は happy-path の 1 本だけ (不変条件 4)。例外は
 * 検証のキャンセル (#331) の 1 本で、「処理中」を掴むために full で流す (理由はその test のコメント)。
 * 同じ系統の兄弟: verify-web-parity / verify-web-submission / verify-web-ui (1 ファイルが CI で Slow Test の閾値 5 分を超えたため分割。共通の手順は helpers/verifyWeb.ts)。
 */

/**
 * キャンセルの spec (#331) で打つコード。full の検証が押すまで処理中に留まるよう、SAMPLE_CODE (約 160 イベント) に
 * コメント 1 行を足してイベント数を倍以上にする (約 1 秒の猶予が数秒になる。コメント行は括弧の自動補完を起こさない)。
 * 増やしすぎると editor 側の PoSW で export が遅くなる。
 */
const CANCELLABLE_CODE = '// padding line for a slower full verification\nint main(void) {\n  return 0;\n}\n';

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

// #331: 重い proof の検証を止める手段が無く、待ち行列の後ろの proof の結果が待たされ続けた。処理中の 1 件を
// キャンセルすると、その項目は未検証 (`cancelled`。error ではない) になり、残りの検証は続く。
//
// **この 1 本だけ full で流す** (packages/e2e/AGENTS.md の不変条件 4 の例外)。キャンセルは「処理中」の
// 項目に対する操作で、fast は PoSW の再計算を飛ばすので一瞬で終わり、処理中を掴めない。full は PoSW を
// 1 イベントずつ再計算する (1 イベント約 9 ms) ので、打鍵を増やした proof なら押すまでの間は処理中に留まる。
// 同じ proof を改名した 3 件を入れるので、どれが処理中かはイベント数の順ではなく到着順で決まる。
test.describe('検証のキャンセル (#331)', () => {
  // full の検証を 3 件 + 再検証 1 件流すので既定より長く待つ。
  test.slow();

  test('検証中の proof をキャンセルすると cancelled になり、残りの proof は検証され、再検証で済みに戻る (#331)', async ({
    page,
  }) => {
    const app = new EditorApp(page);
    await app.openCasualFresh();
    await app.typeCode(CANCELLABLE_CODE);
    const zipPath = await app.exportCurrentTab();
    const zips = [
      await writeZipVariant(zipPath, { renameProof: 'a', outName: 'a.zip' }),
      await writeZipVariant(zipPath, { renameProof: 'b', outName: 'b.zip' }),
      await writeZipVariant(zipPath, { renameProof: 'c', outName: 'c.zip' }),
    ];
    const web = new VerifyWebApp(page);
    await web.open('full');
    await web.addFiles(zips);

    // 処理中の 1 件を開いてキャンセルする。
    const verifying = page.locator('#file-list .file-item[data-status="verifying"]');
    await expect(verifying).toHaveCount(1, { timeout: 60_000 });
    const target = (await verifying.getAttribute('data-filename'))!;
    await web.selectFile(target);
    await web.cancelVerification();

    const settled = await web.waitSettled(3, 240_000);
    const proofs = settled.filter((s) => s.filename.endsWith('_proof.json'));
    expect(proofs, JSON.stringify(settled)).toHaveLength(3);
    expect(proofs.find((s) => s.filename === target)?.status, JSON.stringify(settled)).toBe('cancelled');
    for (const other of proofs.filter((s) => s.filename !== target)) {
      expect(['success', 'warning'], JSON.stringify(settled)).toContain(other.status);
    }
    // キャンセルした proof は判定を出していない (判定の data-* が付かない)。
    expect(await page.locator(`#tabbar .tab[data-filename="${target}"]`).getAttribute('data-status')).toBe('cancelled');
    expect(await page.locator('#assurance-strip').getAttribute('data-integrity')).toBeNull();
    expect(await page.locator('#result-status-icon').getAttribute('data-level')).toBeNull();
    // 集約: キャンセルは passed にも failed にも入らず、別に数える。
    await expect.poll(() => web.proofSummary()).toEqual({ total: 3, passed: 2, failed: 0 });
    expect(await web.proofCancelled()).toBe(1);

    // 再検証で待ちに戻し、済みになる。
    await web.retryVerification();
    const retried = await web.waitSettled(3, 240_000);
    expect(['success', 'warning'], JSON.stringify(retried)).toContain(
      retried.find((s) => s.filename === target)?.status
    );
    await expect.poll(() => web.proofSummary()).toEqual({ total: 3, passed: 3, failed: 0 });
    expect(await web.proofCancelled()).toBe(0);
  });
});
