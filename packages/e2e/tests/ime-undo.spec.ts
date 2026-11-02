import { test, expect } from '@playwright/test';
import { EditorApp, readProofEvents, readProofJson } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * 入力の揺さぶり (#435): 日本語 IME の変換中入力と、undo / redo。どちらも最終内容が
 * エディタ (snapshot の content) と proof の `content` で一致し、verify-cli の content replay
 * (チェーンを再生した結果が content に一致する) が通ることを見る。期待値は文字数ではなく最終文字列で書く。
 */

test('IME の変換中入力 (imeSetComposition → insertText) が記録され、確定した文字列が proof の最終内容になる', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('// ');

  // CDP の IME: 変換中の文字列 (未確定) を出してから、確定した文字列を入れる。
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
  await cdp.send('Input.insertText', { text: '日本' });
  await app.typeCode(';');
  await app.expectConsistent();

  const expected = '// 日本;';
  expect((await app.snapshot()).tabs[0]!.content).toBe(expected);

  await app.waitForSynced();
  const zipPath = await app.exportCurrentTab();
  const proof = (await readProofJson(zipPath)) as { content?: string };
  expect(proof.content).toBe(expected);
  // 確定した文字列が編集イベントとしてチェーンに載っている (content replay が通る根拠)。実測では、変換中の
  // `にほん` が 1 文字ずつの insertText、確定が `日本` の replaceContent として記録される。
  const events = await readProofEvents(zipPath);
  const imeChanges = events.filter(
    (e) => e.type === 'contentChange' && typeof e.data === 'string' && (e.data as string).includes('日本')
  );
  expect(imeChanges.length).toBeGreaterThan(0);

  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
});

test('undo / redo の後の最終内容が proof と一致し、historyUndo / historyRedo が記録されて検証が pass する', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int a = 1;');
  await app.expectConsistent();

  // Monaco の undo は語の切れ目ごと (`int a = 1;` → `int a =`)。キーは Ctrl 系で押す: Playwright の
  // `Desktop Chrome` は Windows の UA なので、Monaco は mac 上でも Ctrl+Z / Ctrl+Shift+Z を undo / redo にする
  // (ControlOrMeta だと mac では Cmd になって何も起きない)。
  await page.keyboard.press('Control+Z');
  await app.expectConsistent();
  expect((await app.snapshot()).tabs[0]!.content).toBe('int a =');
  await page.keyboard.press('Control+Shift+Z');
  await app.expectConsistent();
  expect((await app.snapshot()).tabs[0]!.content).toBe('int a = 1;');

  // もう一度 undo して打ち足し、undo が最終内容に効いている proof にする。
  await page.keyboard.press('Control+Z');
  await app.typeCode(' 2;');
  await app.expectConsistent();
  const expected = 'int a = 2;';
  expect((await app.snapshot()).tabs[0]!.content).toBe(expected);

  await app.waitForSynced();
  const zipPath = await app.exportCurrentTab();
  const proof = (await readProofJson(zipPath)) as { content?: string };
  expect(proof.content).toBe(expected);

  const events = await readProofEvents(zipPath);
  const inputTypes = events.filter((e) => e.type === 'contentChange').map((e) => e.inputType);
  expect(inputTypes).toContain('historyUndo');
  expect(inputTypes).toContain('historyRedo');

  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
});
