import { test, expect } from '@playwright/test';
import { EditorApp, readAllProofEvents, readProofEvents } from '../helpers/app.js';
import { runVerifyCli } from '../helpers/verifyCli.js';
import {
  clickMainMenuItem,
  dropFileOnWorkbench,
  templateFile,
  templateYaml,
  waitDialogClosed,
  waitDialogOpen,
  type TemplateFile,
} from '../helpers/scenario.js';

/**
 * #434-9: テンプレート (YAML) の取込。メインメニューの「テンプレートを読み込む」とドロップの 2 経路で、
 * 確認ダイアログ (`data-dialog="template-import"`) を経て既存のタブを閉じ、ファイルごとにタブを作り、
 * 各 proof に templateInjection が載る。テンプレートでないファイルのドロップは externalInput
 * (`insertFromDrop`) として記録される。どれも export が verify-cli (fast) で pass する。
 */

const FILES: TemplateFile[] = [
  { filename: 'main.c', language: 'c', content: 'int main(void) {\n  return 0;\n}\n' },
  { filename: 'util.py', language: 'python', content: 'def f():\n    pass\n' },
];
const NAME = 'week1-template';

/** 取込の確認に答え、進捗が閉じてファイルの数だけタブができるまで待つ。 */
async function confirmImport(app: EditorApp): Promise<void> {
  await waitDialogOpen(app, 'template-import');
  await app.page.locator('#template-confirm-btn').click();
  await waitDialogClosed(app, 'template-import');
  await waitDialogClosed(app, 'template-progress');
  await expect.poll(async () => (await app.tabs()).length).toBe(FILES.length);
  await app.waitReady();
}

/** 取り込んだタブの検査と、全タブ export → verify。 */
async function expectImportedAndVerified(app: EditorApp, previousIds: string[]): Promise<void> {
  const tabs = await app.tabs();
  expect(tabs.map((t) => t.language)).toEqual(FILES.map((f) => f.language));
  for (const t of tabs) expect(previousIds, 'existing tabs are closed by the import').not.toContain(t.id);
  const snap = await app.snapshot();
  expect(snap.tabs.map((t) => t.content)).toEqual(FILES.map((f) => f.content));
  await app.expectConsistent();

  await app.typeCode('x');
  await app.waitForSynced();
  const zipPath = await app.exportAllTabs();
  const proofs = [...(await readAllProofEvents(zipPath)).values()];
  expect(proofs).toHaveLength(FILES.length);
  for (const events of proofs) {
    const injections = events.filter((e) => e.type === 'templateInjection');
    expect(injections).toHaveLength(1);
    expect((injections[0]!.data as { templateName?: string }).templateName).toBe(NAME);
  }
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  await app.expectConsistent();
}

test('メインメニューからテンプレートを読み込むと既存のタブを閉じてファイルごとのタブができ、verify が pass する', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int old;');
  await app.waitForSynced();
  const previousIds = (await app.tabs()).map((t) => t.id);

  const chooser = page.waitForEvent('filechooser');
  await clickMainMenuItem(page, 'import-template-btn');
  await (await chooser).setFiles(templateFile(NAME, FILES));
  await confirmImport(app);
  await expectImportedAndVerified(app, previousIds);
});

test('テンプレートの YAML をドロップしても同じように取り込まれ、verify が pass する', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int old;');
  await app.waitForSynced();
  const previousIds = (await app.tabs()).map((t) => t.id);

  await dropFileOnWorkbench(page, {
    name: 'template.yaml',
    mimeType: 'application/x-yaml',
    text: templateYaml(NAME, FILES),
  });
  await confirmImport(app);
  await expectImportedAndVerified(app, previousIds);
});

test('テンプレートでないファイルのドロップは取り込まれず externalInput (insertFromDrop) として記録され、verify が pass する', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int a;');
  await app.expectConsistent();
  const before = await app.tabs();

  await dropFileOnWorkbench(page, { name: 'notes.txt', mimeType: 'text/plain', text: 'hello' });
  await app.expectConsistent();
  expect(await app.openDialogs()).not.toContain('template-import');
  expect((await app.tabs()).map((t) => t.id)).toEqual(before.map((t) => t.id));

  await app.waitForSynced();
  const zipPath = await app.exportCurrentTab();
  const events = await readProofEvents(zipPath);
  expect(events.filter((e) => e.type === 'externalInput' && e.inputType === 'insertFromDrop')).toHaveLength(1);
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
});
