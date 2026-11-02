import { test, expect } from '@playwright/test';
import { EditorApp, readAllProofEvents, type EditorMode } from '../helpers/app.js';
import { runVerifyCli } from '../helpers/verifyCli.js';
import {
  SAMPLE_CLASS_ID,
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

    // 問題の数だけタブができ、言語は starter (無ければ allowed の先頭) に従う。ファイル名は #441 があるので見ない。
    const tabs = await app.tabs();
    expect(tabs.map((t) => t.language)).toEqual(problems.map((p) => p.starter?.language ?? 'c'));
    expect(await panelOpen(page, 'problem-panel')).toBe('true');
    expect(await app.openDialogs()).not.toContain('welcome');
    await app.expectConsistent();

    // 空のタブを含む ZIP は検証が拒否する既知のバグ (#447) を避けるため、全タブに書く (下の fixme が再現)。
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

test.fixme('#441 class: starter の filename (p1.c) がそのままタブ名になり、拡張子が二重に付かない', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await openAndLoad(app, 'class');
  expect((await app.tabs())[0]?.filename).toBe('p1.c');
});

test.fixme('#447 class: 書いていない (空の) タブを含む全タブ export が verify (fast) で pass する', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await openAndLoad(app, 'class');
  // p2 は starter が無く、打鍵もしないので 0 バイトのファイルとして ZIP に入る。
  await app.typeCode('int x;');
  const zipPath = await app.exportViaLogButton();
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
});
