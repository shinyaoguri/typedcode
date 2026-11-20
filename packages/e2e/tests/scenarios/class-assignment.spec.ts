import { mkdtempSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { test, expect } from '@playwright/test';
import { EditorApp, listProofEntries, readAllProofEvents, type EditorMode } from '../helpers/app.js';
import { runVerifyCli, runVerifyCliWithResult } from '../helpers/verifyCli.js';
import {
  CLASS_POLICIES,
  SAMPLE_CLASS_ID,
  capabilityContract,
  contractOf,
  loadClassPackage,
  panelOpen,
  sampleClassPackage,
  typeIntoEveryTab,
  waitDialogOpen,
} from '../helpers/scenario.js';

/**
 * #434-3: 授業 (class) / 課題 (assignment) で `.tcclass` を読み込み、問題ごとのタブで書いて export する
 * (ADR-0014/0015)。問題の数だけタブができ、問題パネルが開き、starter のある問題の proof には
 * `templateInjection` (`templateName = tcclass/<classId>/<problemId>`) が載る。export は verify-cli (fast) で pass。
 * 違いは起動時の画面共有の選択: class は出る、assignment は一度も出ない。
 */

const problems = sampleClassPackage().bundle.problems;

/** 起動から問題の読み込みまで。assignment では画面共有の選択が一度も出ないことも見る。 */
async function openAndLoad(app: EditorApp, mode: EditorMode): Promise<void> {
  if (mode === 'class') {
    await app.openModeFresh('class', { screenShare: 'share', waitReady: false });
  } else {
    const seen = new Set<string>();
    await app.openModeFresh('assignment', { waitReady: false });
    await expect
      .poll(async () => {
        for (const d of await app.openDialogs()) seen.add(d);
        return seen.has('welcome');
      })
      .toBe(true);
    expect([...seen], 'assignment never asks to share the screen').not.toContain('screen-share-choice');
  }
  await waitDialogOpen(app, 'welcome');
  expect(await panelOpen(app.page, 'problem-panel')).toBe('false');
  await loadClassPackage(app);
}

for (const mode of ['class', 'assignment'] as const) {
  test(`${mode}: .tcclass を読むと問題ごとのタブと問題パネルが開き、書いた export が verify (fast) で pass する`, async ({
    page,
  }) => {
    const app = new EditorApp(page);
    await openAndLoad(app, mode);
    if (mode === 'assignment') expect(await app.openDialogs()).not.toContain('screen-share-choice');

    // 問題の数だけタブができ、言語は starter (無ければ allowed の先頭) に従う。ファイル名は下の #441 の回帰テストが見る。
    const tabs = await app.tabs();
    expect(tabs.map((t) => t.language)).toEqual(problems.map((p) => p.starter?.language ?? 'c'));
    expect(await panelOpen(page, 'problem-panel')).toBe('true');
    expect(await app.openDialogs()).not.toContain('welcome');
    await app.expectConsistent();

    // 問題ごとのタブで書く (各問題の proof に打鍵が載る)。書かないタブを含む export は下のテストが見る。
    await typeIntoEveryTab(app, 'int x;');
    await app.expectConsistent();

    const zipPath = await app.exportViaLogButton();
    const proofs = [...(await readAllProofEvents(zipPath)).values()];
    expect(proofs).toHaveLength(problems.length);
    const injected = proofs
      .flatMap((events) => events.filter((e) => e.type === 'templateInjection'))
      .map((e) => (e.data as { templateName?: string }).templateName);
    // starter のある問題 (p1) だけが templateInjection を持つ (p2 は starter が無いので記録しない)。
    expect(injected).toEqual(problems.filter((p) => p.starter).map((p) => `tcclass/${SAMPLE_CLASS_ID}/${p.problemId}`));

    const result = runVerifyCli(zipPath, ['--mode', 'fast']);
    expect(result.passed, result.stdout + result.stderr).toBe(true);
    await app.expectConsistent();
  });
}

// #645: 方針 (policy) を持たない旧 .tcclass は、開いた入口の能力のまま開く (/class は教室、/assignment は持ち帰りの値)。
for (const mode of ['class', 'assignment'] as const) {
  test(`${mode}: 方針の無い .tcclass を読んでも入口の能力が変わらない`, async ({ page }) => {
    const app = new EditorApp(page);
    await openAndLoad(app, mode);
    const expected = mode === 'class' ? CLASS_POLICIES.classroom : CLASS_POLICIES.takeHome;
    expect(await capabilityContract(page)).toEqual(contractOf(expected));
    await app.expectConsistent();
  });
}

// 回帰テスト: starter の filename (p1.c) と、starter が無い問題の `<problemId>.<ext>` (p2.c) が、
// 拡張子込みのままタブに渡されて `.c.c` になっていた (#441)。ここは `data-filename` を見る。
// タブに見える文字の二重拡張子 (#828) は scenarios/tab-visible-name.spec.ts が見る。
for (const mode of ['class', 'assignment'] as const) {
  test(`${mode}: タブの名前は starter の filename と <problemId>.<ext> のまま、拡張子が二重に付かない`, async ({
    page,
  }) => {
    const app = new EditorApp(page);
    await openAndLoad(app, mode);
    expect((await app.tabs()).map((t) => t.filename)).toEqual(['p1.c', 'p2.c']);
    expect((await app.snapshot()).tabs.map((t) => t.filename)).toEqual(['p1.c', 'p2.c']);
    await app.expectConsistent();
  });
}

// 回帰テスト: 0 バイトのファイルを含む ZIP を ZIP の予算検査が拒否していた (#447、#449 で修正)。
test('class: 書いていない (空の) タブを含む全タブ export が verify (fast) で pass する', async ({ page }) => {
  const app = new EditorApp(page);
  await openAndLoad(app, 'class');
  // p2 は starter が無く、打鍵もしないので 0 バイトのファイルとして ZIP に入る。
  await app.typeCode('int x;');
  await app.expectConsistent();
  const zipPath = await app.exportViaLogButton();
  expect(await listProofEntries(zipPath)).toHaveLength(problems.length);
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  await app.expectConsistent();
});

/** ZIP のエントリを選び直し (`keep` が false のものを落とし、`extra` を足し) た ZIP を一時ファイルに書く。 */
async function rewriteZip(
  zipPath: string,
  keep: (name: string) => boolean,
  extra: Record<string, string> = {}
): Promise<string> {
  const src = await JSZip.loadAsync(readFileSync(zipPath));
  const out = new JSZip();
  for (const [name, entry] of Object.entries(src.files)) {
    if (!entry.dir && keep(name)) out.file(name, await entry.async('uint8array'));
  }
  for (const [name, text] of Object.entries(extra)) out.file(name, text);
  const dest = join(mkdtempSync(join(tmpdir(), 'tc-e2e-problem-')), 'variant.zip');
  await writeFile(dest, await out.generateAsync({ type: 'nodebuffer' }));
  return dest;
}

/** verify-cli が孤立ソース (どの proof の期待名にも当たらない同梱ファイル) を警告した行。exit code には出ないので stdout で見る。 */
const ORPHAN_WARNING = 'Source file not matched to any proof';

// #778: 授業で問題を読み込んだタブの問題文を `<base>_problem.md` として ZIP に入れる。証明の対象外の平文なので、
// proof に問題文は入らず、verify-cli は孤立ソースとして数えず、結論は同梱しない ZIP と同じになる。
test('class: 書き出した ZIP に各タブの問題文 (<base>_problem.md) が入り、verify-cli (fast) の結論は同梱しないときと同じ', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await openAndLoad(app, 'class');
  await app.typeCode('int x;');
  await app.expectConsistent();
  const zipPath = await app.exportViaLogButton();
  const zip = await JSZip.loadAsync(readFileSync(zipPath));

  // 問題ごとに 1 つ、中身は配布ファイルの statement と UTF-8 のバイト単位で同じ。
  const problemNames = Object.keys(zip.files).filter((name) => name.includes('_problem'));
  expect(problemNames.sort()).toEqual(problems.map((p) => `${p.problemId}_problem.md`));
  for (const p of problems) {
    const bytes = await zip.file(`${p.problemId}_problem.md`)!.async('nodebuffer');
    expect(bytes.equals(Buffer.from(p.statement, 'utf-8')), `${p.problemId}_problem.md`).toBe(true);
  }

  // 証明 JSON の中身は変わらない: どの proof にも問題文が入らない。statement は改行を含むので、
  // JSON の文字列として書かれたときの形 (`\n` にエスケープされた形) で探す。
  const proofNames = await listProofEntries(zipPath);
  expect(proofNames).toHaveLength(problems.length);
  for (const name of proofNames) {
    const proofText = await zip.file(name)!.async('string');
    for (const p of problems) expect(proofText, name).not.toContain(JSON.stringify(p.statement).slice(1, -1));
  }

  // verify-cli (fast) は pass し、問題文を孤立ソースとして警告しない。
  const bundled = runVerifyCliWithResult(zipPath, ['--mode', 'fast']);
  expect(bundled.passed, bundled.stdout + bundled.stderr).toBe(true);
  expect(bundled.stdout).not.toContain(ORPHAN_WARNING);

  // 結論は問題文を抜いた ZIP と同じ。
  const stripped = runVerifyCliWithResult(await rewriteZip(zipPath, (name) => !name.includes('_problem')), [
    '--mode',
    'fast',
  ]);
  expect(bundled.results).toEqual(stripped.results);
  expect(bundled.exitCode).toBe(stripped.exitCode);

  // 負の対照: 問題文の形でない .md を足すと、同じ verify-cli が孤立ソースとして警告する (警告を読めていることの確認)。
  const withNotes = runVerifyCli(await rewriteZip(zipPath, () => true, { 'notes.md': 'memo' }), ['--mode', 'fast']);
  expect(withNotes.stdout).toContain(`${ORPHAN_WARNING}: notes.md`);
  await app.expectConsistent();
});
