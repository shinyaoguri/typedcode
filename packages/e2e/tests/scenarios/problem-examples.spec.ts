import { test, expect } from '@playwright/test';
import { EditorApp, readAllProofEvents } from '../helpers/app.js';
import { runVerifyCli } from '../helpers/verifyCli.js';
import {
  SAMPLE_PROBLEM_EXAMPLES,
  classPackageFile,
  loadClassPackage,
  readProblemExamples,
  sampleClassPackageWithExamples,
  waitDialogOpen,
  waitResumed,
} from '../helpers/scenario.js';

/**
 * #648: 問題の入出力例 (ADR-0048)。入出力例付きの `.tcclass` を読むと、問題パネルの「動作確認の例」の節に
 * 配布物どおりの名前・入力・出力が出る。例を持たない問題では節が出ず、タブの切り替えとリロードで
 * 問題に合った例に戻る。入力のコピーは stdin をそのままクリップボードに入れ、proof に何も記録しない。
 * コードを実行しないので言語を問わない (PR ゲート)。判定は状態契約 (data-*) だけで行う。
 */

/** `<pre>` は末尾の改行 1 つを除いて見せる (ProblemPanel の表示規則)。 */
const shown = (text: string): string => text.replace(/\n$/, '');

/** 配布物の p1 の例が、問題パネルにそのまま出ているときの読み取り結果。 */
const expectedP1 = {
  count: String(SAMPLE_PROBLEM_EXAMPLES.length),
  examples: SAMPLE_PROBLEM_EXAMPLES.map((e, index) => ({
    index: String(index),
    name: e.name,
    stdin: e.stdin.length > 0 ? shown(e.stdin) : null,
    noInput: e.stdin.length === 0,
    stdout: shown(e.stdout),
  })),
};

async function openClassWithExamples(app: EditorApp): Promise<void> {
  await app.openModeFresh('class', { screenShare: 'share', waitReady: false });
  await waitDialogOpen(app, 'welcome');
  await loadClassPackage(app, classPackageFile(sampleClassPackageWithExamples()));
}

test('class: 入出力例は持つ問題にだけ配布物どおりに出て、タブの切り替えとリロードで問題に合った例に戻る', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await openClassWithExamples(app);
  const [p1Tab, p2Tab] = await app.tabs();
  expect(p1Tab?.active).toBe(true);

  expect(await readProblemExamples(page)).toEqual(expectedP1);

  // p2 は例を持たないので節が出ない (p1 の例が残らない)
  await app.switchToTab(p2Tab!.id);
  await expect.poll(() => readProblemExamples(page)).toBeNull();

  await app.switchToTab(p1Tab!.id);
  await expect.poll(() => readProblemExamples(page)).toEqual(expectedP1);
  await app.expectConsistent();

  // リロードしても ClassProblemStore から同じ例が出る。class は起動のたびに画面共有の選択が出るので、
  // reloadAndResume ではなく選択に答えてから復元を待つ
  await app.waitForSynced();
  await page.reload();
  const share = page.locator('.screen-share-choice-dialog [data-choice="share"]');
  await share.waitFor({ state: 'visible', timeout: 30_000 });
  await share.click();
  await waitResumed(app);
  await expect(page.locator('#problem-panel')).toHaveAttribute('data-open', 'true', { timeout: 30_000 });
  expect((await app.tabs()).find((t) => t.active)?.id).toBe(p1Tab!.id);
  await expect.poll(() => readProblemExamples(page)).toEqual(expectedP1);
  await app.expectConsistent();
});

test('class: 入力のコピーは stdin をそのままクリップボードに入れ、proof に記録せず、export が verify (fast) で pass する', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await openClassWithExamples(app);
  await app.typeCode('int x;');
  await app.expectConsistent();

  const copy = page.locator('#problem-examples [data-example-index="0"] [data-action="copy-stdin"]');
  await copy.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(SAMPLE_PROBLEM_EXAMPLES[0].stdin);
  // 入力の無い例にはコピーするものが無いのでボタンを出さない
  await expect(page.locator('#problem-examples [data-example-index="1"] [data-action="copy-stdin"]')).toHaveCount(0);
  await app.expectConsistent();

  const zipPath = await app.exportViaLogButton();
  const proofs = [...(await readAllProofEvents(zipPath)).values()];
  expect(proofs).toHaveLength(2);
  for (const events of proofs) {
    expect(events.filter((e) => e.type === 'copyOperation')).toEqual([]);
  }

  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  await app.expectConsistent();
});
