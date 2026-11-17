import { test, expect } from '@playwright/test';
import { measureLayout } from './helpers/uiInvariants.js';
import { blockExternalRequests, FLOW_SCREENS, TOUR_FLOWS, walkTour } from './helpers/uiTour.js';
import { VerifyWebApp } from './helpers/verifyWeb.js';

/**
 * レイアウトの退行検査 (#728 / #346 PR 6)。viewport.spec.ts と同じ狭い画面 (タブレット縦 768×1024 と
 * スマートフォン相当 480×800) で対象画面 (helpers/uiTour.ts) を巡り、
 * - 文書全体が横にスクロールしない
 * - 画面の左右からはみ出して切られている要素が無い (コード欄・タブ列・ターミナルなど、内部でスクロールする
 *   箱の中身は除く。判定は helpers/uiInvariants.ts の measureLayout)
 * - 開いているダイアログが画面に収まっている
 * ことを見る。画素は比べない。viewport.spec.ts はこの画面サイズでの操作と検証の往復を見る (ここでは操作しない)。
 */

const VIEWPORTS = [
  { width: 768, height: 1024 },
  { width: 480, height: 800 },
] as const;

const CLEAN = { pageScrollsX: false, clippedByViewport: [], dialogsOutsideViewport: [] };

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport, locale: 'en-US' });

    for (const flow of TOUR_FLOWS) {
      test(`${flow} at ${viewport.width}×${viewport.height}: nothing overflows the viewport on ${FLOW_SCREENS[flow].join(', ')}`, async ({
        page,
      }) => {
        await walkTour(page, flow, async (screen) => {
          expect.soft(await measureLayout(page), `${screen}: overflow`).toEqual(CLEAN);
        });
      });
    }
  });
}

// 負の対照: 画面より大きいダイアログと、切られる横長の要素を拾い、内部スクロールの箱の中身は拾わないこと。
test.describe('negative control', () => {
  test.use({ viewport: VIEWPORTS[1], locale: 'en-US' });

  test('the layout check reports an oversized dialog and clipped content but not content inside a scroll box', async ({
    page,
  }) => {
    await blockExternalRequests(page);
    const web = new VerifyWebApp(page);
    await web.open('fast');
    expect(await measureLayout(page), 'the untouched page fits').toEqual(CLEAN);

    // 内部スクロールの箱 (画面に収まる・overflow-x: auto) の中の横長の中身は、意図したスクロールとして拾わない
    await page.evaluate(() => {
      const box = document.createElement('div');
      box.id = 'e2e-scroll-box';
      box.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:50px;overflow-x:auto';
      const wide = document.createElement('div');
      wide.style.cssText = 'width:3000px;height:20px';
      box.append(wide);
      document.body.append(box);
    });
    expect(await measureLayout(page)).toEqual(CLEAN);

    // 受け止める箱の無い横長の要素は、body の overflow: hidden で切られるはみ出しとして拾う
    await page.evaluate(() => {
      const wide = document.createElement('div');
      wide.id = 'e2e-wide';
      wide.style.cssText = 'position:fixed;left:0;bottom:0;width:3000px;height:20px';
      document.body.append(wide);
    });
    const clipped = await measureLayout(page);
    expect(clipped.clippedByViewport.join('\n')).toContain('div#e2e-wide');
    expect(clipped.clippedByViewport.join('\n')).not.toContain('e2e-scroll-box');
    await page.evaluate(() => document.getElementById('e2e-wide')!.remove());

    // 画面より大きいダイアログ
    await page.evaluate(() => {
      const dialog = document.createElement('div');
      dialog.id = 'e2e-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.style.cssText = 'position:fixed;left:40px;top:40px;width:400px;height:900px';
      document.body.append(dialog);
    });
    expect((await measureLayout(page)).dialogsOutsideViewport.join('\n')).toContain('div#e2e-dialog');
  });
});
