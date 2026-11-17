import { test, expect, type Page } from '@playwright/test';
import { EditorApp, readProofEvents, type ProofEvent } from './helpers/app.js';
import { runVerifyCliWithVerdicts, type CliVerdictEntry } from './helpers/verifyCli.js';

/**
 * IME の composition と直接挿入の出自 (#720)。
 *
 * editor は以前、CJK の文字を含む複数文字の挿入を文字種だけで IME の確定 (`insertFromComposition`) と
 * 記録していたので、composition を経ない長い直接挿入 (拡張機能などの executeEdits) が一括挿入の評価を
 * 素通りした。いまは Monaco の `onDidCompositionStart` / `onDidCompositionEnd` に範囲で対応付いた編集
 * だけを composition 系 (`insertCompositionText` / `insertFromComposition` / `deleteCompositionText`) に
 * する。
 *
 * composition は CDP の `Input.imeSetComposition` / `Input.insertText` で合成している。これは Chromium の
 * IME 経路を通るが実際の IME (日本語・中国語・韓国語の各 IME、音声入力、支援技術) ではないので、この spec
 * が緑でも実 IME に対応済みの根拠にはしない (実機の確認は #720 の受け入れ条件に残す)。取消は
 * `imeSetComposition('')` で行う: `Input.insertText('')` で取り消すと Monaco に compositionEnd が届かず
 * composition が開いたまま残る (実測)。
 */

/** #720 の再現入力: 日本語 1 文字入りの 346 文字の 1 行。 */
const DIRECT_INSERT = `int main(){${'int x=1;'.repeat(40)}return 0;} // あ`;

const COMPOSITION_TYPES = new Set(['insertCompositionText', 'insertFromComposition', 'deleteCompositionText']);

interface Observed {
  /** proof の全イベント (記録順)。 */
  events: ProofEvent[];
  /** そのうちの contentChange。 */
  changes: ProofEvent[];
  verdict: CliVerdictEntry;
}

/** 現在のタブを export し、contentChange と verify-cli (fast) の判定を読む。 */
async function exportAndVerify(app: EditorApp): Promise<Observed> {
  await app.waitForSynced();
  const zipPath = await app.exportCurrentTab();
  const events = await readProofEvents(zipPath);
  const result = runVerifyCliWithVerdicts(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
  const verdict = result.verdicts[0]!;
  expect(verdict.valid).toBe(true);
  return { events, changes: events.filter((e) => e.type === 'contentChange'), verdict };
}

/** CDP の合成 composition。`commit` を渡せばその文字列で確定する。 */
async function compose(page: Page, preedit: string, commit?: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', {
    text: preedit,
    selectionStart: preedit.length,
    selectionEnd: preedit.length,
  });
  if (commit !== undefined) {
    await cdp.send('Input.insertText', { text: commit });
  }
  await cdp.detach();
}

/** 取消: 空の preedit で composition を閉じる。 */
async function cancelComposition(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
  await cdp.detach();
}

function withData(changes: ProofEvent[], data: string): ProofEvent | undefined {
  return changes.find((e) => e.data === data);
}

test('composition を経ない直接挿入は insertReplacementText として残り、Pure Typing: NO / 外部入力になる', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('// ');
  await app.injectCodeBlock(DIRECT_INSERT);

  const { changes, verdict } = await exportAndVerify(app);
  expect(withData(changes, DIRECT_INSERT)?.inputType).toBe('insertReplacementText');
  expect(changes.filter((e) => COMPOSITION_TYPES.has(String(e.inputType)))).toEqual([]);
  expect(verdict.assurance.provenance.pureTyping).toBe(false);
  expect(verdict.processSummary.externalInputCount).toBeGreaterThanOrEqual(1);
});

test('同じ文字列の通常の外部ペーストは insertFromPaste として残る', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('// ');
  await app.pasteExternalText(DIRECT_INSERT);

  const { events, changes, verdict } = await exportAndVerify(app);
  // ペーストは InputDetector の externalInput (insertFromPaste) と、Monaco の内容変更の 2 段で残る。
  // 内容変更は composition に対応しないので、文字種によらず composition 系にはならない
  const paste = events.find((e) => e.inputType === 'insertFromPaste');
  expect(paste?.type).toBe('externalInput');
  expect(paste?.data).toBe(DIRECT_INSERT);
  expect(withData(changes, DIRECT_INSERT)?.inputType).toBe('insertReplacementText');
  expect(changes.filter((e) => COMPOSITION_TYPES.has(String(e.inputType)))).toEqual([]);
  expect(verdict.assurance.provenance.pureTyping).toBe(false);
  expect(verdict.processSummary.externalInputCount).toBeGreaterThanOrEqual(1);
});

test('IME の確定 (にほん → 日本) は composition 系として残り、Pure Typing: YES / 外部入力 0', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('// ');
  await compose(page, 'にほん', '日本');
  await app.typeCode(';');
  await app.expectConsistent();
  expect((await app.snapshot()).tabs[0]!.content).toBe('// 日本;');

  const { changes, verdict } = await exportAndVerify(app);
  // ASCII の印字可能文字 (空白〜チルダ) 以外を含む編集 = かな・漢字の編集
  const cjk = changes.filter((e) => typeof e.data === 'string' && /[^ -~]/.test(e.data));
  expect(cjk.length).toBeGreaterThan(0);
  expect(cjk.map((e) => e.inputType).filter((t) => !COMPOSITION_TYPES.has(String(t)))).toEqual([]);
  expect(COMPOSITION_TYPES.has(String(withData(changes, '日本')?.inputType))).toBe(true);
  expect(verdict.assurance.provenance.pureTyping).toBe(true);
  expect(verdict.processSummary.externalInputCount).toBe(0);
});

test('150 文字を超える長い確定も composition 系で、Pure Typing: YES', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('// ');
  const committed = '亜'.repeat(160);
  await compose(page, 'あ'.repeat(160), committed);
  await app.expectConsistent();
  expect((await app.snapshot()).tabs[0]!.content).toBe(`// ${committed}`);

  const { changes, verdict } = await exportAndVerify(app);
  expect(COMPOSITION_TYPES.has(String(withData(changes, committed)?.inputType))).toBe(true);
  expect(verdict.assurance.provenance.pureTyping).toBe(true);
  expect(verdict.processSummary.externalInputCount).toBe(0);
});

test('取消した composition は deleteCompositionText として残り、内容は元に戻る', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('// ');
  await compose(page, 'あい');
  await cancelComposition(page);
  await app.typeCode('x');
  await app.expectConsistent();
  expect((await app.snapshot()).tabs[0]!.content).toBe('// x');

  const { changes, verdict } = await exportAndVerify(app);
  expect(changes.map((e) => e.inputType)).toContain('deleteCompositionText');
  expect(withData(changes, 'x')?.inputType).toBe('insertText');
  expect(verdict.assurance.provenance.pureTyping).toBe(true);
  expect(verdict.processSummary.externalInputCount).toBe(0);
});

test('再変換 (確定済みの文字を選んで変換し直す) は composition 系として残る', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('// ');
  await compose(page, 'にほん', '日本');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  await compose(page, 'にほん', '二本');
  await app.expectConsistent();
  expect((await app.snapshot()).tabs[0]!.content).toBe('// 二本');

  const { changes, verdict } = await exportAndVerify(app);
  expect(COMPOSITION_TYPES.has(String(withData(changes, '二本')?.inputType))).toBe(true);
  expect(verdict.assurance.provenance.pureTyping).toBe(true);
  expect(verdict.processSummary.externalInputCount).toBe(0);
});

test('確定の後の直接挿入は composition に帰属せず insertReplacementText のまま', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('// ');
  await compose(page, 'にほん', '日本');
  await app.injectCodeBlock(DIRECT_INSERT);

  const { changes, verdict } = await exportAndVerify(app);
  expect(COMPOSITION_TYPES.has(String(withData(changes, '日本')?.inputType))).toBe(true);
  expect(withData(changes, DIRECT_INSERT)?.inputType).toBe('insertReplacementText');
  expect(verdict.assurance.provenance.pureTyping).toBe(false);
  expect(verdict.processSummary.externalInputCount).toBeGreaterThanOrEqual(1);
});

test('composition の途中でタブを切り替えた後の直接挿入は composition に帰属しない', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('// ');
  await compose(page, 'にほん');
  const firstTab = (await app.snapshot()).activeTabId;
  await app.addTab();
  await expect.poll(async () => (await app.snapshot()).activeTabId).not.toBe(firstTab);
  await app.injectCodeBlock(DIRECT_INSERT);

  const { changes, verdict } = await exportAndVerify(app);
  expect(withData(changes, DIRECT_INSERT)?.inputType).toBe('insertReplacementText');
  expect(changes.filter((e) => COMPOSITION_TYPES.has(String(e.inputType)))).toEqual([]);
  expect(verdict.assurance.provenance.pureTyping).toBe(false);
});
