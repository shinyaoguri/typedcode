import { test, expect, type Page } from '@playwright/test';
import { EditorApp } from './helpers/app.js';

/**
 * 未対応ブラウザの遮断 (#596)。E2E は Chromium でしか回していない (ADR-0033) ので、editor は Chromium 系
 * だけで記録させ、Safari (WebKit) と Firefox (Gecko) は起動の Phase 0.5 で `unsupported-browser` を出して止める。
 * 実物の Safari / Firefox は動かさず、UA を上書きした Chromium で入口の判定を確かめる (判定は UA 文字列だけを
 * 見る。`app/browserSupport.ts`。UA ごとの細かい境界はユニットの `browserSupport.test.ts`)。
 *
 * 判定は `data-dialog` / `html[data-app-state]` / タブの状態契約 / `#event-count[data-count]` と、
 * セッション DB (`typedcode-session*`) が作られたかだけを読む (翻訳テキストは読まない)。
 */

const UA = {
  safari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  chrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
} as const;

/** このページの origin にある、セッション DB (モード別に `typedcode-session` / `typedcode-session-<mode>`) の名前。 */
function sessionDatabases(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await indexedDB.databases()).map((db) => db.name ?? '').filter((name) => name.startsWith('typedcode-session'))
  );
}

for (const [name, userAgent] of [
  ['Safari', UA.safari],
  ['Firefox', UA.firefox],
] as const) {
  test.describe(`${name} の UA`, () => {
    test.use({ userAgent });

    test(`${name} の UA で開くと unsupported-browser が出て、タブも記録も始まらない`, async ({ page }) => {
      const app = new EditorApp(page);
      await page.goto('/casual');

      await expect.poll(() => app.openDialogs(), { timeout: 30_000 }).toContain('unsupported-browser');
      // 起動を途中で止める画面なので initializing のまま残る (editor/AGENTS.md の状態契約)。
      expect(await app.appState()).toBe('initializing');
      expect(await app.tabs()).toEqual([]);
      expect(await app.eventCount()).toBe(0);
      expect(await sessionDatabases(page)).toEqual([]);
      // 止まった画面の後ろで、利用規約や画面共有の選択など次の段階のダイアログが開いていない。
      expect(await app.openDialogs()).toEqual(['unsupported-browser']);
    });
  });
}

// 遮断の誤検出の境界: Chromium 系の UA では出さず、ready まで起動して #0 を記録する。
for (const [name, userAgent] of [
  ['Chrome', UA.chrome],
  ['Edge', UA.edge],
] as const) {
  test.describe(`${name} の UA`, () => {
    test.use({ userAgent });

    test(`${name} の UA では unsupported-browser が出ず、記録が始まる`, async ({ page }) => {
      const app = new EditorApp(page);
      await app.openCasualFresh();
      await expect.poll(() => app.appState()).toBe('ready');
      expect(await app.openDialogs()).not.toContain('unsupported-browser');
      expect(await app.tabs()).toHaveLength(1);
      expect(await sessionDatabases(page)).toEqual(['typedcode-session']);
    });
  });
}
