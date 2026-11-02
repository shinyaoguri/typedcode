import { test, expect } from '@playwright/test';
import { EditorApp, listProofEntries } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * editor の状態契約 (#433): タブ・カウンタ・言語・ダイアログの操作を一通り行い、各操作の後で
 * DOM の data-* と内部状態 (dev フック `__tcTestSnapshot`) が一致することを `expectConsistent()` で確かめる。
 * 後続の利用シーン網羅・障害注入・model-based E2E (#434〜#436) はこの契約と `expectConsistent()` を土台にする。
 *
 * 証明の妥当性は従来どおり verify-cli の結論で見る (途中で export して `--mode fast` で pass)。
 */
test('casual: タブ操作の各段階で DOM の状態契約と内部状態が一致し、全部閉じるとウェルカムになる', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();

  // 起動直後: 既定タブ 1 本 (ADR-0015) が active で、ダイアログは開いていない。
  await expect.poll(() => app.appState()).toBe('ready');
  await app.expectConsistent();
  const [first] = await app.tabs();
  expect(first).toMatchObject({ filename: 'Untitled-1.c', language: 'c', active: true });
  expect(await app.openDialogs()).toEqual([]);

  // 打鍵: 件数・ハッシュがアクティブなタブの proof に追従する。
  await app.typeCode('int a = 1;\n');
  await app.expectConsistent();
  const afterTyping = await app.snapshot();
  expect(afterTyping.tabs[0]!.content).toContain('int a = 1;');

  // タブ追加: 新しいタブが末尾に並んで active になる。
  await app.addTab();
  await app.expectConsistent();
  const tabsAfterAdd = await app.tabs();
  expect(tabsAfterAdd.map((t) => t.id)[0]).toBe(first!.id);
  const second = tabsAfterAdd[1]!;
  expect(second).toMatchObject({ filename: 'Untitled-2.c', active: true });
  await app.typeCode('int b = 2;\n');
  await app.expectConsistent();

  // 改名: 確定後に DOM の data-filename と snapshot の filename が新しい名前 (拡張子込み) になる。
  await app.renameTab(second.id, 'renamed');
  await app.expectConsistent();
  expect((await app.tabs()).find((t) => t.id === second.id)?.filename).toBe('renamed.c');
  expect((await app.snapshot()).tabs.find((t) => t.id === second.id)?.filename).toBe('renamed.c');

  // タブ切替: 先頭のタブに戻る。
  await app.switchToTab(first!.id);
  await app.expectConsistent();
  expect((await app.snapshot()).activeTabId).toBe(first!.id);

  // 言語変更: アクティブなタブの language と、言語で決まる拡張子が変わる。
  await app.setLanguage('python');
  await app.expectConsistent();
  expect((await app.tabs()).find((t) => t.id === first!.id)).toMatchObject({
    language: 'python',
    filename: 'Untitled-1.py',
  });

  // export → verify-cli (fast) が全 proof を pass させる。セルフレビューが閉じたあとはダイアログが残らない。
  await app.waitForSynced();
  const zipPath = await app.exportAllTabs();
  expect(await listProofEntries(zipPath)).toHaveLength(2);
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  await expect.poll(() => app.openDialogs()).toEqual([]);
  await app.expectConsistent();

  // 閉じるのをキャンセル: 確認ダイアログが開いて閉じ、タブは減らない。
  await app.requestCloseTab(first!.id);
  await app.answerCloseTab('cancel');
  await app.expectConsistent();
  expect((await app.tabs()).map((t) => t.id)).toEqual([first!.id, second.id]);

  // 閉じる (確定): アクティブなタブを閉じると、残ったタブが active になる。
  await app.requestCloseTab(first!.id);
  await app.answerCloseTab('confirm');
  await app.expectConsistent();
  expect(await app.tabs()).toEqual([expect.objectContaining({ id: second.id, active: true })]);

  // 最後のタブを閉じる: ウェルカム画面になり、タブ 0 本・active 無し・カウンタはリセット。
  await app.requestCloseTab(second.id);
  await app.answerCloseTab('confirm');
  await expect.poll(() => app.openDialogs()).toContain('welcome');
  await app.expectConsistent();
  expect(await app.tabs()).toEqual([]);
  const finalSnapshot = await app.snapshot();
  expect(finalSnapshot).toMatchObject({ appState: 'ready', activeTabId: null, tabs: [] });
});
