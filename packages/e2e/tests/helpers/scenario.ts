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

/** p1 の入出力例 (#648)。2 件目は入力なし。stdin は複数行で、貼ったときに 2 行として記録される形。 */
export const SAMPLE_PROBLEM_EXAMPLES = [
  { name: '例1: 3 と 5', stdin: '3\n5\n', stdout: '8\n' },
  { name: '例2: 入力なし', stdin: '', stdout: 'hello\nworld\n' },
] as const;

/**
 * `sampleClassPackage` の p1 にだけ入出力例 (#648 / ADR-0048) を付けたもの。p2 は例を持たない
 * (節が出ないことを見るため)。
 */
export function sampleClassPackageWithExamples() {
  const pkg = sampleClassPackage();
  const [p1, p2] = pkg.bundle.problems;
  return {
    ...pkg,
    bundle: { ...pkg.bundle, problems: [{ ...p1!, examples: SAMPLE_PROBLEM_EXAMPLES.map((e) => ({ ...e })) }, p2!] },
  };
}

/**
 * `.tcclass` の方針 (#645)。/author の「教室で実施」= `/class`、「持ち帰り」= `/assignment` の能力値
 * (editor の `CLASS_POLICY_PRESETS`)。
 */
export const CLASS_POLICIES = {
  classroom: { screenshots: true, fullscreenTracking: true, preExportBestEffort: true },
  takeHome: { screenshots: false, fullscreenTracking: false, preExportBestEffort: false },
} as const;

/** 方針が決める 3 つの実効の能力 (状態契約 `html[data-cap-*]`)。値は `'true'` / `'false'` (属性が無ければ null) */
export async function capabilityContract(
  page: Page
): Promise<Record<keyof typeof CLASS_POLICIES.classroom, string | null>> {
  const html = page.locator('html');
  return {
    screenshots: await html.getAttribute('data-cap-screenshots'),
    fullscreenTracking: await html.getAttribute('data-cap-fullscreen-tracking'),
    preExportBestEffort: await html.getAttribute('data-cap-pre-export-best-effort'),
  };
}

/** 方針を状態契約の文字列にしたもの (`capabilityContract` と比べる) */
export function contractOf(policy: Record<keyof typeof CLASS_POLICIES.classroom, boolean>) {
  return {
    screenshots: String(policy.screenshots),
    fullscreenTracking: String(policy.fullscreenTracking),
    preExportBestEffort: String(policy.preExportBestEffort),
  };
}

/** 問題パッケージ (既定は `sampleClassPackage`) を JSON 化した `.tcclass`。 */
export function classPackageFile(pkg: object = sampleClassPackage()): FilePayload {
  return {
    name: 'week3.tcclass',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(pkg)),
  };
}

/** 問題パネルの入出力例の節 (#648) を状態契約 (data-*) だけで読む。節が無ければ null。 */
export interface RenderedProblemExamples {
  count: string | null;
  examples: Array<{ index: string; name: string; stdin: string | null; noInput: boolean; stdout: string | null }>;
}

export function readProblemExamples(page: Page): Promise<RenderedProblemExamples | null> {
  return page.evaluate(() => {
    const section = document.querySelector<HTMLElement>('#problem-examples');
    if (!section) return null;
    return {
      count: section.dataset.exampleCount ?? null,
      examples: [...section.querySelectorAll<HTMLElement>('[data-example-index]')].map((block) => ({
        index: block.dataset.exampleIndex ?? '',
        name: block.querySelector('[data-role="name"]')?.textContent ?? '',
        stdin: block.querySelector('pre[data-role="stdin"]')?.textContent ?? null,
        noInput: block.querySelector('[data-role="no-input"]') !== null,
        stdout: block.querySelector('pre[data-role="stdout"]')?.textContent ?? null,
      })),
    };
  });
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

/** 方針の 3 つの能力 (`.tcclass` の `policy`)。 */
export type ClassPolicyValue = Record<keyof typeof CLASS_POLICIES.classroom, boolean>;

/**
 * 方針の URL の符号 (#646)。editor の `classPolicyCode` と同じ規則を E2E 側で独立に持つ (期待値なので実装から引かない):
 * 「教室で実施」= `classroom`、「持ち帰り」= `take-home`、それ以外は `custom-<s><f><b>` (0/1)。
 */
export function policyCode(policy: ClassPolicyValue): string {
  const bits = [policy.screenshots, policy.fullscreenTracking, policy.preExportBestEffort].map((b) => (b ? '1' : '0'));
  const joined = bits.join('');
  if (joined === '111') return 'classroom';
  if (joined === '000') return 'take-home';
  return `custom-${joined}`;
}

/** `policyCode` の逆 (作業スペースの URL から方針を読む)。 */
function policyOfCode(code: string): ClassPolicyValue {
  if (code === 'classroom') return { ...CLASS_POLICIES.classroom };
  if (code === 'take-home') return { ...CLASS_POLICIES.takeHome };
  const m = /^custom-([01])([01])([01])$/.exec(code);
  if (!m) throw new Error(`unknown policy code: ${code}`);
  return { screenshots: m[1] === '1', fullscreenTracking: m[2] === '1', preExportBestEffort: m[3] === '1' };
}

/** 作業スペースの URL のパス (#646): `/w/class/<encodeURIComponent(classId)>/<方針の符号>`。 */
export function workspacePath(classId: string, policy: ClassPolicyValue): string {
  return `/w/class/${encodeURIComponent(classId)}/${policyCode(policy)}`;
}

/**
 * `.tcclass` を `fromPath` で読み込んだときに開く作業スペースのパス (#646 の決定 4)。方針は配布物の方針、
 * 無ければ入口の既定: 作業スペースの中ならその方針、`/class` は「教室で実施」、`/assignment` と練習 (`/`) は「持ち帰り」。
 */
export function expectedWorkspacePath(pkg: { classId: string; policy?: ClassPolicyValue }, fromPath: string): string {
  const ws = /^\/w\/class\/[^/]+\/([^/]+)\/?$/.exec(fromPath);
  const entrance = ws
    ? policyOfCode(ws[1]!)
    : fromPath.replace(/\/+$/, '') === '/class'
      ? CLASS_POLICIES.classroom
      : CLASS_POLICIES.takeHome;
  return workspacePath(pkg.classId, pkg.policy ?? entrance);
}

/** 言語 id → 拡張子 (editor の `examFileExtension` と同じ対応。問題のタブのファイル名の期待値に使う) */
const PROBLEM_FILE_EXTENSIONS: Record<string, string> = {
  c: 'c',
  cpp: 'cpp',
  python: 'py',
  javascript: 'js',
  typescript: 'ts',
};

interface ClassPackageShape {
  classId: string;
  policy?: ClassPolicyValue;
  allowed?: { languages?: string[] };
  bundle?: { problems?: Array<{ problemId: string; starter?: { filename?: string; language?: string } }> };
}

/** 配布物の各問題のタブのファイル名 (`data-filename`): starter の filename、無ければ `<problemId>.<ext>` */
export function problemFilenames(pkg: ClassPackageShape): string[] {
  return (pkg.bundle?.problems ?? []).map((p) => {
    if (p.starter?.filename) return p.starter.filename;
    const language = p.starter?.language ?? pkg.allowed?.languages?.[0] ?? 'c';
    return `${p.problemId}.${PROBLEM_FILE_EXTENSIONS[language] ?? language}`;
  });
}

/** 「問題を読み込む」(`#load-problem-btn`) を押してローダを開く。 */
export async function openClassLoader(app: EditorApp): Promise<void> {
  await app.page.locator('#load-problem-btn').click();
  await waitDialogOpen(app, 'class-problem-loader');
}

/**
 * 開いているローダに `.tcclass` を入れて読み込み、問題タブができてエディタと記録が立ち上がるまで待つ。
 * 読み込むと、その配布物の作業スペース (`/w/class/<classId>/<方針>`。#646) へページごと移り、移り先の起動が
 * 問題のタブを開く。今の作業スペースと同じ (改訂) なら移らずにその場で開く。
 * スクリーンショットを撮る方針の作業スペースは起動のたびに画面共有の選択を出すので、`screenShare` で選ぶ
 * (省略時は `share`)。利用規約に未同意なら、移り先 (練習以外) で規約のモーダルが出る (呼び出し側で同意しておく)。
 */
export async function submitClassPackage(
  app: EditorApp,
  file: FilePayload = classPackageFile(),
  opts: { screenShare?: 'share' | 'optOut' } = {}
): Promise<void> {
  const { page } = app;
  const pkg = JSON.parse(file.buffer.toString('utf8')) as ClassPackageShape;
  const fromPath = new URL(page.url()).pathname;
  const target = expectedWorkspacePath(pkg, fromPath);
  await page.locator('#class-loader-file').setInputFiles(file);
  const load = page.locator('#class-loader-load');
  await expect(load).toBeEnabled();
  await load.click();
  if (fromPath === target) {
    await waitDialogClosed(app, 'class-problem-loader');
  } else {
    await page.waitForURL((url) => url.pathname === target, { timeout: 30_000 });
    if (policyOfCode(target.split('/')[4]!).screenshots) {
      const choice = opts.screenShare ?? 'share';
      const button = page.locator(`.screen-share-choice-dialog [data-choice="${choice}"]`);
      await button.waitFor({ state: 'visible', timeout: 30_000 });
      await button.click();
      if (choice === 'optOut') {
        const confirm = page.locator('.screen-share-optout-confirm-dialog [data-action="confirm"]');
        await confirm.waitFor({ state: 'visible', timeout: 30_000 });
        await confirm.click();
      }
    }
  }
  await app.waitReady();
  // 問題タブは 1 本ずつ作られる (main.ts の openClassTabs)。waitReady は先頭のタブで抜け、改訂では問題パネルも
  // 開いたままなので、全問題のタブがそろうまで data-filename で待つ。最後に問題パネルが開く。
  const expected = problemFilenames(pkg);
  await expect
    .poll(
      async () => {
        const open = new Set((await app.tabs()).map((t) => t.filename));
        return expected.filter((name) => !open.has(name));
      },
      { timeout: 60_000 }
    )
    .toEqual([]);
  await expect(page.locator('#problem-panel')).toHaveAttribute('data-open', 'true', { timeout: 30_000 });
  await expect.poll(() => app.appState(), { timeout: 30_000 }).toBe('ready');
}

/**
 * 「問題を読み込む」から `.tcclass` を取り込み、その作業スペースで問題タブができるまで待つ (`submitClassPackage`)。
 */
export async function loadClassPackage(
  app: EditorApp,
  file: FilePayload = classPackageFile(),
  opts: { screenShare?: 'share' | 'optOut' } = {}
): Promise<void> {
  await openClassLoader(app);
  await submitClassPackage(app, file, opts);
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
 * 要素の CSS トランジション (開閉のアニメーション) が終わり、幅が止まるまで待って、その幅を返す。止まったとみなすのは
 * 「`getAnimations()` に running のものが無く、前回の読みと幅が同じ」とき。開いた直後に幅を読む・
 * ハンドルを掴むと、アニメーション途中の値を読み、まだ動いているハンドルを掴み損ねる (#816)。
 */
export async function waitWidthSettled(page: Page, selector: string): Promise<number> {
  let previous = Number.NaN;
  let settled = Number.NaN;
  await expect
    .poll(
      async () => {
        const { animating, width } = await page.locator(selector).evaluate((el) => ({
          animating: el.getAnimations().some((a) => a.playState === 'running'),
          width: el.getBoundingClientRect().width,
        }));
        const stable = !animating && width === previous;
        previous = width;
        if (stable) settled = width;
        return stable;
      },
      { message: `${selector} の幅が止まらない` }
    )
    .toBe(true);
  return settled;
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
 * 左のダウンロードボタン (`#download-btn`) で全タブを export し、セルフレビュー (`data-dialog="self-review"`) に
 * ノートを書いて続行する。保存した ZIP のパスを返す。
 */
export async function exportWithNote(app: EditorApp, note: string): Promise<string> {
  const downloadPromise = app.page.waitForEvent('download', { timeout: 90_000 });
  await openSelfReviewForExport(app);
  await app.page.locator('#self-review-note').fill(note);
  await app.page.locator('[data-dialog="self-review"] [data-action="proceed"]').click();
  return saveDownload(await downloadPromise);
}

/** 左のダウンロードボタンで export を始め (メニューは開かない。#779)、セルフレビューが開くまで待つ。 */
export async function openSelfReviewForExport(app: EditorApp): Promise<void> {
  await app.page.locator('#download-btn').click();
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
 * 全タブに順に打鍵する (問題ごとのタブで書く・全タブの中身が保たれることを見る、といったシナリオ用)。
 */
export async function typeIntoEveryTab(app: EditorApp, text: string): Promise<void> {
  for (const tab of await app.tabs()) {
    await app.switchToTab(tab.id);
    await app.typeCode(text);
  }
}
