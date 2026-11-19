import { test, expect, type Page } from '@playwright/test';
import { EditorApp } from '../helpers/app.js';
import { runVerifyCli } from '../helpers/verifyCli.js';
import { dragBy, loadClassPackage, panelOpen, waitDialogOpen, waitWidthSettled, widthOf } from '../helpers/scenario.js';

/**
 * ログビューアの幅の下限と上限の係数。packages/editor/src/ui/components/LogViewerPanel.ts の `handleMouseMove`
 * (`minWidth = 200` / `maxWidth = mainWidth * 0.7`) の写しで、製品は定数を export していない。製品の値を変えたら
 * ここも合わせる。既定の寸法 (main 1232px・開いた幅 35%) の ±120px のドラッグはどちらにも掛からないので、ずれても
 * この spec の期待値は変わらず、ずれが偽の赤・偽の緑を生むのは下限・上限に掛かる寸法のときだけ。
 */
const LOG_MIN_WIDTH = 200;
const LOG_MAX_WIDTH_RATIO = 0.7;

/**
 * ログビューアのハンドルを dx (px) ドラッグした後にあるべき幅。`handleMouseMove` と同じく、掴んだ時点の
 * `offsetWidth` (整数に丸めた幅) からマウスの移動の逆向き (左へ動かすと広がる) に足し、`main` の実寸の下限・上限で挟む。
 */
async function expectedLogWidthAfterDrag(page: Page, dx: number): Promise<number> {
  const { start, mainWidth } = await page.evaluate(() => ({
    start: (document.getElementById('log-viewer') as HTMLElement).offsetWidth,
    mainWidth: (document.querySelector('main') as HTMLElement).clientWidth,
  }));
  return Math.max(LOG_MIN_WIDTH, Math.min(mainWidth * LOG_MAX_WIDTH_RATIO, start - dx));
}

/** ログビューアを dx ドラッグし、幅が式どおり (端数の丸めの分 ±2px) になることを確かめて、ドラッグ後の幅を返す。 */
async function dragLogViewerBy(page: Page, dx: number): Promise<number> {
  const expected = await expectedLogWidthAfterDrag(page, dx);
  await dragBy(page, '#log-resize-handle', dx);
  await expect
    .poll(async () => Math.abs((await widthOf(page, '#log-viewer')) - expected), {
      message: `#log-viewer の幅が ${expected}px (±2) にならない`,
    })
    .toBeLessThanOrEqual(2);
  return widthOf(page, '#log-viewer');
}

/**
 * #434-10: ログビューア (`#log-viewer`) と問題パネル (`#problem-panel`) の開閉とリサイズ。開閉は状態契約
 * `data-open` で、リサイズはパネルの幅 (boundingBox) の変化で見る。操作のたびに DOM と内部状態が一致し、
 * 最後の export が verify-cli (fast) で pass する。ログのクリアは UI にボタンが無い (#443) ので対象外。
 */
test('class: 問題パネルとログビューアを開閉・リサイズしても状態が一致し、export が verify (fast) で pass する', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openModeFresh('class', { screenShare: 'share', waitReady: false });
  await waitDialogOpen(app, 'welcome');
  await loadClassPackage(app);
  await app.typeCode('int a;');

  // 問題パネル: 読み込みで開く → × で閉じる → Activity Bar のトグルで開く → 右端のハンドルで広げる。
  expect(await panelOpen(page, 'problem-panel')).toBe('true');
  await page.locator('#close-problem-btn').click();
  await expect(page.locator('#problem-panel')).toHaveAttribute('data-open', 'false');
  await app.expectConsistent();
  await page.locator('#toggle-problem-btn').click();
  await expect(page.locator('#problem-panel')).toHaveAttribute('data-open', 'true');
  const problemBefore = await widthOf(page, '#problem-panel');
  await dragBy(page, '#problem-resize-handle', 120);
  await expect.poll(() => widthOf(page, '#problem-panel')).toBeGreaterThan(problemBefore + 50);
  await app.expectConsistent();

  // ログビューア: トグルで開く → 左端のハンドルで広げる → 縮める → × で閉じる → もう一度開く。
  // 開くと 0.3 秒のトランジションで広がる。その途中で幅を読んでハンドルを掴むと、動いているハンドルを掴み損ねて
  // ドラッグが効かない (#816) ので、幅が止まってから読む。期待値は固定の伸び幅ではなく製品の式から出す。
  expect(await panelOpen(page, 'log-viewer')).toBe('false');
  await page.locator('#toggle-log-btn').click();
  await expect(page.locator('#log-viewer')).toHaveAttribute('data-open', 'true');
  const logBefore = await waitWidthSettled(page, '#log-viewer');
  const logWidened = await dragLogViewerBy(page, -120);
  expect(logWidened).toBeGreaterThan(logBefore);
  const logNarrowed = await dragLogViewerBy(page, 120);
  expect(logNarrowed).toBeLessThan(logWidened);
  await app.expectConsistent();
  await page.locator('#close-log-btn').click();
  await expect(page.locator('#log-viewer')).toHaveAttribute('data-open', 'false');
  await page.locator('#toggle-log-btn').click();
  await expect(page.locator('#log-viewer')).toHaveAttribute('data-open', 'true');
  await app.expectConsistent();

  await app.typeCode(' int b;');
  await app.waitForSynced();
  const zipPath = await app.exportViaLogButton();
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  await app.expectConsistent();
});
