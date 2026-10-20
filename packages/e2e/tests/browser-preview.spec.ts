import { test, expect, type FrameLocator, type Page } from '@playwright/test';
import { EditorApp } from './helpers/app.js';

/**
 * HTML プレビュー (BrowserPreviewPanel) の隔離と表示の回帰テスト (#291 / #299)。
 *
 * プレビュー iframe は `sandbox="allow-scripts allow-modals allow-forms"` (allow-same-origin なし)
 * の opaque origin で動かし、内容は srcdoc で投入する。学習者が書いた/読み込んだ HTML から
 * 親ページの DOM・保存領域 (localStorage / proof イベントを持つ IndexedDB)・トップレベル遷移・
 * ポップアップに届かないことを、実ブラウザ (Chromium) で確かめる。
 *
 * 証明 (proof) は対象外なので export / verify-cli は回さない。オラクルは「プレビュー内の
 * スクリプトが自分で観測した結果 (`#r`)」と「親ページ側の状態」の両面。
 *
 * HTML の投入は dev フック (`injectCodeBlock`) を使う。Monaco の HTML モードは `>` 入力で
 * 閉じタグを自動補完するため、keyboard.type だと意図した HTML にならない。
 */

/** アクティブタブの言語を切り替える (ステータスバーの言語セレクタ)。 */
async function setActiveTabLanguage(page: Page, language: string): Promise<void> {
  await page.locator('#language-selector').selectOption(language);
}

/** プレビューパネルを開く (titlebar のトグル)。 */
async function openPreview(page: Page): Promise<void> {
  await page.locator('#toggle-preview-btn').click();
  await expect(page.locator('#browser-preview')).toHaveClass(/visible/);
}

/** プレビューの更新ボタンを押す。 */
async function refreshPreview(page: Page): Promise<void> {
  await page.locator('#refresh-preview-btn').click();
}

/** n 番目 (0 始まり) のタブを閉じる (確認ダイアログを承認)。 */
async function closeTab(page: Page, index: number): Promise<void> {
  await page.locator('#editor-tabs .editor-tab').nth(index).locator('.tab-close-btn').click();
  await page.locator('#tab-close-confirm-btn').click();
}

function preview(page: Page): FrameLocator {
  return page.frameLocator('#preview-iframe');
}

test('プレビュー内のスクリプトは動くが、親 document・localStorage・IndexedDB には届かない', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();

  await setActiveTabLanguage(page, 'html');
  await app.injectCodeBlock(
    [
      '<p id="t">ok</p>',
      '<p id="r"></p>',
      '<script>',
      '  const r = document.getElementById("r");',
      '  const out = [];',
      '  try { parent.document.title = "pwned-by-preview"; out.push("dom:open"); } catch (e) { out.push("dom:blocked"); }',
      '  try { localStorage.setItem("tc-preview-pwned", "1"); out.push("ls:open"); } catch (e) { out.push("ls:blocked"); }',
      '  r.textContent = out.join(" ");',
      '  try {',
      '    indexedDB.databases().then(',
      '      (dbs) => { r.textContent += " idb:open:" + dbs.map((d) => d.name).join(","); },',
      '      () => { r.textContent += " idb:blocked"; }',
      '    );',
      '  } catch (e) { r.textContent += " idb:blocked"; }',
      '</script>',
    ].join('\n')
  );
  await openPreview(page);

  // HTML とスクリプトはプレビューとして動作している (隔離で機能を殺していない)。
  await expect(preview(page).locator('#t')).toHaveText('ok');
  await expect(preview(page).locator('#r')).toContainText('idb:');

  // 親 document・localStorage・IndexedDB (proof イベントの保存先) へのアクセスはすべて拒否される。
  await expect(preview(page).locator('#r')).toHaveText('dom:blocked ls:blocked idb:blocked');
  expect(await page.title()).not.toBe('pwned-by-preview');
  expect(await page.evaluate(() => localStorage.getItem('tc-preview-pwned'))).toBeNull();

  // sandbox 化しても親は cross-origin isolated のまま (Wasmer の SharedArrayBuffer を壊さない)。
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
});

test('プレビューからトップレベル遷移とポップアップはできない', async ({ page, context }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  const urlBefore = page.url();

  let popups = 0;
  context.on('page', () => {
    popups++;
  });

  await setActiveTabLanguage(page, 'html');
  await app.injectCodeBlock(
    [
      '<p id="r"></p>',
      '<script>',
      '  const out = [];',
      '  let w = null;',
      '  try { w = window.open("about:blank", "_blank"); } catch (e) {}',
      '  out.push(w ? "popup:open" : "popup:blocked");',
      '  try { top.location.href = "about:blank#tc-escaped"; out.push("nav:open"); } catch (e) { out.push("nav:blocked"); }',
      '  document.getElementById("r").textContent = out.join(" ");',
      '</script>',
    ].join('\n')
  );
  await openPreview(page);

  // 遷移やポップアップは非同期に起きうるので少し待ってから親側を確認する。
  await page.waitForTimeout(1_000);
  expect(page.url()).toBe(urlBefore);
  expect(popups).toBe(0);
  await expect(preview(page).locator('#r')).toHaveText('popup:blocked nav:blocked');
});

test('CSS/JS タブのインライン化・alert・同一ドキュメント内のフォーム送信が隔離後も動く', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();

  // Untitled-1 = HTML、Untitled-2 = CSS、Untitled-3 = JS。HTML から拡張子付きで参照する。
  await setActiveTabLanguage(page, 'html');
  await app.injectCodeBlock(
    [
      '<link rel="stylesheet" href="Untitled-2.css">',
      '<p id="t">styled</p>',
      '<p id="js"></p>',
      '<button id="alert-btn" onclick="alert(\'tc-preview-alert\')">alert</button>',
      '<form id="f" onsubmit="event.preventDefault(); document.getElementById(\'fr\').textContent = \'submitted\';">',
      '  <button id="submit-btn" type="submit">submit</button>',
      '</form>',
      '<p id="fr"></p>',
      '<script src="Untitled-3.js"></script>',
    ].join('\n')
  );
  await app.addTab();
  await setActiveTabLanguage(page, 'css');
  await app.injectCodeBlock('#t { color: rgb(255, 0, 0); }');
  await app.addTab();
  await setActiveTabLanguage(page, 'javascript');
  await app.injectCodeBlock('document.getElementById("js").textContent = "from-js-tab";');

  // アクティブタブが HTML でなくても、最初の HTML タブがプレビューされる。
  await openPreview(page);
  const frame = preview(page);
  await expect(frame.locator('#js')).toHaveText('from-js-tab');
  await expect(frame.locator('#t')).toHaveCSS('color', 'rgb(255, 0, 0)');

  // allow-modals: alert は表示される。alert はフレームのイベントループを止めるので、
  // click の完了を待つ前にハンドラで閉じる (waitForEvent だけだと click が返らない)。
  let dialogMessage: string | null = null;
  page.once('dialog', (dialog) => {
    dialogMessage = dialog.message();
    void dialog.accept();
  });
  await frame.locator('#alert-btn').click();
  await expect.poll(() => dialogMessage).toBe('tc-preview-alert');

  // allow-forms: submit イベントが発火する (preventDefault で遷移はしない)。
  await frame.locator('#submit-btn').click();
  await expect(frame.locator('#fr')).toHaveText('submitted');
});

test('編集による再描画でプレビューのスクロール位置が維持される', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();

  await setActiveTabLanguage(page, 'html');
  await app.injectCodeBlock('<div style="height: 4000px">top</div>\n<p id="end">end</p>\n');
  await openPreview(page);

  const body = preview(page).locator('body');
  await expect(preview(page).locator('#end')).toHaveText('end');
  await body.evaluate(() => window.scrollTo(0, 800));
  // 位置が親に伝わる猶予を置いてから、旧ドキュメントに目印を付ける。
  await page.waitForTimeout(300);
  await body.evaluate((el) => {
    el.dataset.stale = '1';
  });

  // 1 文字編集 → debounce (300ms) 後に再描画される。目印の無い新ドキュメントで位置を確認する。
  await app.focusEditor();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' ');
  // srcdoc の再代入でフレームが再読込されるため、その最中の evaluate は
  // "Execution context was destroyed" で投げる。poll は例外をそのまま失敗にするので、
  // 再読込中は -2 (まだ新ドキュメントではない) として再試行する。期待値の 800 は緩めない。
  await expect
    .poll(() => body.evaluate((el) => (el.dataset.stale ? -1 : Math.round(window.scrollY))).catch(() => -2), {
      timeout: 10_000,
    })
    .toBe(800);
});

test('HTML タブが無い状態 (placeholder) から HTML タブを追加するとプレビューが表示される', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();

  // 既定タブ (C) のみ = HTML なし → placeholder。
  await openPreview(page);
  await expect(page.locator('#preview-placeholder')).toBeVisible();

  await app.addTab();
  await setActiveTabLanguage(page, 'html');
  await app.injectCodeBlock('<p id="t">restored</p>');
  await refreshPreview(page);

  await expect(page.locator('#preview-placeholder')).toBeHidden();
  await expect(preview(page).locator('#t')).toHaveText('restored');
});

test('最後の HTML タブを閉じて再追加してもプレビューが表示され、表示/非表示も動く', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();

  // Untitled-1 (C) + Untitled-2 (HTML) で表示。
  await app.addTab();
  await setActiveTabLanguage(page, 'html');
  await app.injectCodeBlock('<p id="t">first</p>');
  await openPreview(page);
  await expect(preview(page).locator('#t')).toHaveText('first');

  // 唯一の HTML タブを閉じる → placeholder。
  await closeTab(page, 1);
  await expect(page.locator('#editor-tabs .editor-tab')).toHaveCount(1);
  await refreshPreview(page);
  await expect(page.locator('#preview-placeholder')).toBeVisible();

  // HTML タブを再追加 → 新しい内容が表示される。
  await app.addTab();
  await setActiveTabLanguage(page, 'html');
  await app.injectCodeBlock('<p id="t">restored</p>');
  await refreshPreview(page);
  await expect(page.locator('#preview-placeholder')).toBeHidden();
  await expect(preview(page).locator('#t')).toHaveText('restored');

  // 非表示 → 再表示でも同じ内容が出る。
  await page.locator('#toggle-preview-btn').click();
  await expect(page.locator('#browser-preview')).not.toHaveClass(/visible/);
  await openPreview(page);
  await expect(preview(page).locator('#t')).toHaveText('restored');
});
