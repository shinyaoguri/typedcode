import { test, expect, type Page } from '@playwright/test';
import { EditorApp, readProofEvents, type ProofEvent } from './helpers/app.js';
import { runVerifyCliWithVerdicts } from './helpers/verifyCli.js';

/**
 * ターミナルへの貼り付けはコードへの外部入力にしない (#697)。
 *
 * paste / drop / copy の検出はコード編集領域 (Monaco のコンテナ) が target のものだけを拾う。
 * ターミナル (xterm の入力 textarea) へ stdin のつもりで貼った文字列が、コードのカーソル位置への
 * externalInput / contentChange として proof に入らないことを、記録件数 (`#event-count[data-count]`)・
 * proof の中身・verify-cli の pureTyping で確かめる。C / Python の実物の stdin の実行は @nightly でしか
 * 動かないので、ここではターミナルの textarea に paste イベントを直接届ける。実行中でない
 * ターミナルは入力を捨てる (CTerminal) ので、正しければ貼り付けで記録は 1 件も増えない。
 * 同じ proof に、エディタへの実ペーストが引き続き insertFromPaste で残る正の対照を置く。
 */

const STDIN_SAMPLE = 'TERMINAL_STDIN_7 11';
const EDITOR_PASTE = 'PASTED_INTO_EDITOR';

/**
 * ターミナルの入力 textarea に、外部由来テキストの paste イベントを届ける。
 * xterm は Ctrl+V を制御文字 (^V) として扱い、headless の Chromium では実ペーストの paste イベントが
 * 出ない (実測) ので、ブラウザが貼り付けで出すのと同じ形 (clipboardData を持つ ClipboardEvent) を
 * textarea に dispatch する。xterm 自身の paste の処理もこのイベントで動く
 */
async function pasteIntoTerminal(page: Page, text: string): Promise<void> {
  const textarea = page.locator('#xterm-container .xterm-helper-textarea');
  await textarea.focus();
  await expect(textarea).toBeFocused();
  await textarea.evaluate((el, t) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, text);
}

/** ソースへの編集として記録されたイベント (externalInput / contentChange) のうち data に text を含むもの */
function codeEventsContaining(events: ProofEvent[], text: string): ProofEvent[] {
  return events.filter(
    (e) => (e.type === 'externalInput' || e.type === 'contentChange') && String(e.data ?? '').includes(text)
  );
}

/** ターミナルに貼り付けても記録件数が増えないことを、PoSW と保存が落ち着いた所で確かめる */
async function expectTerminalPasteRecordsNothing(app: EditorApp): Promise<void> {
  await app.waitForSynced();
  const before = await app.eventCount();

  await pasteIntoTerminal(app.page, STDIN_SAMPLE);
  // 記録は fire-and-forget なので、増えるならこの間に表示へ出る
  await app.page.waitForTimeout(1_000);
  await app.waitForSynced();

  expect(await app.eventCount(), 'pasting into the terminal must not record a code event').toBe(before);
}

test('ターミナルへの貼り付けは記録せず、エディタへの貼り付けは insertFromPaste で残る', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int x = 1;\n');

  await expectTerminalPasteRecordsNothing(app);
  await app.pasteExternalText(EDITOR_PASTE);

  const events = await readProofEvents(await app.exportCurrentTab());

  // 負の対照: ターミナルへ貼った文字列はソースへの編集として載らない
  expect(codeEventsContaining(events, STDIN_SAMPLE)).toEqual([]);
  // 正の対照: Monaco への外部ペーストは引き続き検出・記録される
  const editorPaste = events.find(
    (e) => e.inputType === 'insertFromPaste' && String(e.data ?? '').includes(EDITOR_PASTE)
  );
  expect(editorPaste?.type, 'external paste into the editor should still be recorded').toBe('externalInput');
});

test('ターミナルにだけ貼り付けた proof は Pure Typing のまま', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int x = 1;\n');

  await expectTerminalPasteRecordsNothing(app);

  const zipPath = await app.exportCurrentTab();
  const events = await readProofEvents(zipPath);
  expect(events.filter((e) => e.type === 'externalInput')).toEqual([]);

  const result = runVerifyCliWithVerdicts(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  expect(result.verdicts[0]!.assurance.provenance.pureTyping).toBe(true);
  expect(result.verdicts[0]!.processSummary.externalInputCount).toBe(0);
});
