import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Download, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { EditorApp } from './app.js';

/**
 * 利用シーン網羅 (#434, `tests/scenarios/`) の共通ヘルパー。`app.ts` (EditorApp) は並行作業と
 * 衝突しないよう触らず、シナリオ固有の操作・フィクスチャをここに置く。
 *
 * 判定に使うのは editor の状態契約 (packages/editor/AGENTS.md「状態契約」の data-* と
 * `__tcTestSnapshot`) だけ。操作 (クリック対象) は既存の DOM id を使う。
 */

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

/** 授業 / 課題の問題パッケージの classId (proof の templateName `tcclass/<classId>/<problemId>` に載る)。 */
export const SAMPLE_CLASS_ID = '2026-algo-week3';

/**
 * 平文の問題パッケージ (`.tcclass`)。shared の `classPackage.test.ts` の `samplePackage` と同じ中身
 * (p1 は starter あり、p2 は starter なし)。
 */
export function sampleClassPackage() {
  return {
    schema: 'tcclass/1',
    classId: SAMPLE_CLASS_ID,
    allowed: { languages: ['c', 'python'] },
    bundle: {
      schema: 'tcexam-exam/1',
      problems: [
        {
          problemId: 'p1',
          statement: '# 問題1\n和を出力せよ。',
          starter: { filename: 'p1.c', language: 'c', content: '/* TODO */\n' },
        },
        { problemId: 'p2', statement: '# 問題2\n積を出力せよ。' },
      ],
    },
  };
}

/** Playwright の setInputFiles / ドロップに渡すファイル。 */
export interface FilePayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

/** `sampleClassPackage` を JSON 化した `.tcclass`。 */
export function classPackageFile(): FilePayload {
  return {
    name: 'week3.tcclass',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(sampleClassPackage())),
  };
}

/** テンプレート (YAML) の 1 ファイル分。 */
export interface TemplateFile {
  filename: string;
  language: string;
  content: string;
}

/**
 * テンプレートの YAML (`{version, metadata:{name}, files:[{filename, language, content}]}`。
 * editor の `template/TemplateParser.ts`)。content は block scalar (`|`) で書く。
 */
export function templateYaml(name: string, files: TemplateFile[]): string {
  const lines = ['version: "1.0"', 'metadata:', `  name: "${name}"`, 'files:'];
  for (const f of files) {
    lines.push(`  - filename: "${f.filename}"`, `    language: "${f.language}"`, '    content: |');
    for (const l of f.content.replace(/\n$/, '').split('\n')) lines.push(`      ${l}`);
  }
  return `${lines.join('\n')}\n`;
}

/** テンプレートの YAML を `.yaml` のファイルにする。 */
export function templateFile(name: string, files: TemplateFile[]): FilePayload {
  return { name: 'template.yaml', mimeType: 'application/x-yaml', buffer: Buffer.from(templateYaml(name, files)) };
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

/** 左の設定メニュー (`#settings-btn`) を開いて項目を押す。 */
export async function clickSettingsItem(page: Page, itemId: string): Promise<void> {
  await page.locator('#settings-btn').click();
  await page.locator(`#${itemId}`).click();
}

/** 左のメインメニュー (`#main-menu-btn`) を開いて項目を押す。 */
export async function clickMainMenuItem(page: Page, itemId: string): Promise<void> {
  await page.locator('#main-menu-btn').click();
  await page.locator(`#${itemId}`).click();
}

/** ダイアログ (`data-dialog`) が開くまで待つ。 */
export async function waitDialogOpen(app: EditorApp, name: string): Promise<void> {
  await expect.poll(() => app.openDialogs(), { timeout: 30_000 }).toContain(name);
}

/** ダイアログ (`data-dialog`) が閉じるまで待つ (`.hidden` が付く / DOM から外れる)。 */
export async function waitDialogClosed(app: EditorApp, name: string): Promise<void> {
  await expect.poll(() => app.openDialogs(), { timeout: 30_000 }).not.toContain(name);
}

/** パネルの開閉 (状態契約 `data-open`)。 */
export function panelOpen(page: Page, panelId: 'log-viewer' | 'problem-panel'): Promise<string | null> {
  return page.locator(`#${panelId}`).getAttribute('data-open');
}

/**
 * 授業 / 課題で「問題を読み込む」(`#load-problem-btn`) から `.tcclass` を取り込み、問題タブができて
 * エディタと記録が立ち上がるまで待つ。
 */
export async function loadClassPackage(app: EditorApp, file: FilePayload = classPackageFile()): Promise<void> {
  await app.page.locator('#load-problem-btn').click();
  await waitDialogOpen(app, 'class-problem-loader');
  await app.page.locator('#class-loader-file').setInputFiles(file);
  const load = app.page.locator('#class-loader-load');
  await expect(load).toBeEnabled();
  await load.click();
  await waitDialogClosed(app, 'class-problem-loader');
  await app.waitReady();
  // 問題タブは 1 本ずつ作られ、最後に問題パネルが開く (main.ts の openClassTabs)。waitReady は先頭のタブで
  // 抜けるので、全タブがそろったことはパネルの data-open で待つ。
  await expect(app.page.locator('#problem-panel')).toHaveAttribute('data-open', 'true', { timeout: 30_000 });
}

/**
 * リロード・遷移の後に、前回セッションの復元 (復旧ダイアログが出れば「再開」) を待つ。
 * `EditorApp.reloadAndResume` の後半と同じ (リロードを Playwright でなくページ自身が起こす経路用)。
 */
export async function waitResumed(app: EditorApp): Promise<void> {
  const resume = app.page.locator('#session-resume-btn');
  try {
    await resume.waitFor({ state: 'visible', timeout: 5_000 });
    await resume.click();
  } catch {
    /* 自動復元 (モーダル無し) */
  }
  await app.waitReady();
}

/**
 * タブ `tabId` をマウスで掴み、`targetX` (クライアント座標) まで引きずって離す。TabUIController は
 * 5px の閾値を超えた mousemove でドラッグを始めるので、複数ステップで動かす。
 */
export async function dragTabTo(page: Page, tabId: string, targetX: number): Promise<void> {
  const box = await page.locator(`#editor-tabs .editor-tab[data-tab-id="${tabId}"] .tab-filename`).boundingBox();
  if (!box) throw new Error(`tab ${tabId} is not visible`);
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 10, y, { steps: 2 });
  await page.mouse.move(targetX, y, { steps: 10 });
  await page.mouse.up();
}

/** 要素の左上から右下へ (dx, dy) だけマウスでドラッグする (リサイズハンドル用)。 */
export async function dragBy(page: Page, selector: string, dx: number, dy = 0): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} is not visible`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 10 });
  await page.mouse.up();
}

/** 要素の幅 (px)。リサイズの前後比較用。 */
export async function widthOf(page: Page, selector: string): Promise<number> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} is not visible`);
  return box.width;
}

/**
 * Monaco の外 (`.workbench`) にファイルをドロップする。dragenter → dragover → drop を `DataTransfer`
 * 付きで発火する (テンプレートの取込は `.workbench` の drop、外部入力の記録は body の capture で拾う)。
 */
export async function dropFileOnWorkbench(page: Page, file: { name: string; mimeType: string; text: string }) {
  await page.evaluate(({ name, mimeType, text }) => {
    const target = document.querySelector('.workbench');
    if (!target) throw new Error('.workbench not found');
    const dt = new DataTransfer();
    dt.items.add(new File([text], name, { type: mimeType }));
    for (const type of ['dragenter', 'dragover', 'drop'] as const) {
      target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
  }, file);
}

/**
 * 現在のタブをダウンロードメニューから export し、セルフレビュー (`data-dialog="self-review"`) に
 * ノートを書いて続行する。保存した ZIP のパスを返す。
 */
export async function exportCurrentTabWithNote(app: EditorApp, note: string): Promise<string> {
  const downloadPromise = app.page.waitForEvent('download', { timeout: 90_000 });
  await openSelfReviewForCurrentTab(app);
  await app.page.locator('#self-review-note').fill(note);
  await app.page.locator('[data-dialog="self-review"] [data-action="proceed"]').click();
  return saveDownload(await downloadPromise);
}

/** 現在のタブの export を始め、セルフレビューが開くまで待つ。 */
export async function openSelfReviewForCurrentTab(app: EditorApp): Promise<void> {
  await app.page.locator('#download-menu-btn').click();
  await app.page.locator('#export-current-tab-btn').click();
  await waitDialogOpen(app, 'self-review');
}

/** ダウンロードを一時ディレクトリに保存してパスを返す。 */
export async function saveDownload(download: Download): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'tc-e2e-dl-'));
  const dest = join(dir, download.suggestedFilename());
  await download.saveAs(dest);
  return dest;
}

/**
 * 全タブに順に打鍵する。空のファイル (0 バイト) を含む export ZIP は verify-cli が拒否する既知の
 * バグ (#447) があるので、全タブ export の前に呼んで空のタブを残さない。
 */
export async function typeIntoEveryTab(app: EditorApp, text: string): Promise<void> {
  for (const tab of await app.tabs()) {
    await app.switchToTab(tab.id);
    await app.typeCode(text);
  }
}
