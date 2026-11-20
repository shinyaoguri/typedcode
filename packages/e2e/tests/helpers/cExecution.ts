import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { EditorApp } from './app.js';

/**
 * 実物の C / C++ (Wasmer + clang) を動かす `@nightly` の spec の共通の手順 (#708 / #711)。
 *
 * 実行の状態は状態契約 (ターミナルのコンテナの `data-exec-state` / `data-exec-run` / `data-exec-outcome`) で読み、
 * 翻訳テキストに依存しない。ターミナルの中身は利用者のコードが出した文字列と clang の英語のメッセージだけを読む。
 */

export const TERMINAL = '#xterm-container';

/** 実行系の取得・初期化 (clang の webc は約 100 MB) を含む 1 回目の実行の終わりを待つ上限 (CDN の遅い夜を見込む) */
export const FIRST_RUN_TIMEOUT_MS = 240_000;

/** アクティブなタブの中身を code に置き換える (Monaco の自動補完・自動インデントを通らない 1 回の編集で入れる) */
export async function replaceCode(app: EditorApp, code: string): Promise<void> {
  await app.focusEditor();
  await app.page.keyboard.press('Control+A');
  await app.page.keyboard.press('Delete');
  await app.injectCodeBlock(code);
}

/** 行の配列でコードを置く (最後に改行を付ける) */
export async function replaceLines(app: EditorApp, lines: string[]): Promise<void> {
  await replaceCode(app, `${lines.join('\n')}\n`);
}

export async function execState(page: Page) {
  return page.locator(TERMINAL).evaluate((el) => ({
    state: el.getAttribute('data-exec-state'),
    run: Number(el.getAttribute('data-exec-run') ?? '0'),
    outcome: el.getAttribute('data-exec-outcome'),
  }));
}

/** Run を押し、その run が始まった (data-exec-run が進んだ) ところで run の番号を返す */
export async function startRun(page: Page): Promise<number> {
  const run = (await execState(page)).run + 1;
  await page.locator('#run-code-btn').click();
  await expect(page.locator(TERMINAL)).toHaveAttribute('data-exec-run', String(run), { timeout: 15_000 });
  return run;
}

/** run が終わる (data-exec-run が run で data-exec-state=idle) まで待って outcome を返す */
export async function waitOutcome(page: Page, run: number, timeout: number): Promise<string | null> {
  await expect
    .poll(
      async () => {
        const s = await execState(page);
        return s.run === run && s.state === 'idle';
      },
      { timeout, intervals: [500, 1_000, 2_000] }
    )
    .toBe(true);
  return (await execState(page)).outcome;
}

/** Run を押し、その run が終わるまで待って outcome を返す */
export async function runAndWait(page: Page, timeout = FIRST_RUN_TIMEOUT_MS): Promise<string | null> {
  return waitOutcome(page, await startRun(page), timeout);
}

/** ターミナルの見えている行の文字列 (xterm の DOM レンダラの行) */
export async function terminalText(page: Page): Promise<string> {
  return page
    .locator(`${TERMINAL} .xterm-rows`)
    .evaluate((el) => Array.from(el.children, (row) => (row.textContent ?? '').replace(/\u00a0/g, ' ')).join('\n'));
}

/**
 * ターミナルのパネルを上へ広げる (`#terminal-resize-handle` をドラッグ)。既定の高さは 10 行ほどで、コンパイラの診断と
 * 実行の出力を合わせると run の先頭が流れるので、出力を数える前に広げる。xterm は広がった分だけ scrollback から行を戻す。
 * ハンドルは run の後 (パネルが開いてから) にしか掴めない
 */
export async function enlargeTerminal(page: Page): Promise<void> {
  const rows = () => page.locator(`${TERMINAL} .xterm-rows`).evaluate((el) => el.children.length);
  const before = await rows();
  const box = await page.locator('#terminal-resize-handle').boundingBox();
  if (!box) throw new Error('#terminal-resize-handle is not visible (open the terminal by running first)');
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, Math.max(0, box.y - 400), { steps: 10 });
  await page.mouse.up();
  await expect.poll(rows).toBeGreaterThan(before);
}

/**
 * ターミナルに re が何回現れるか (診断が重複して転送されていないかを見る)。
 * 見えている行しか読めないので、run の先頭の行 (controller が書く `$ Compiling ...`) が見えていること
 * = run の出力が全部画面に収まっていることを確かめてから数える。収まっていなければ数えずに落とす
 * (重複で出力が伸びて先頭が流れたときに、見えている分だけ数えて 1 回と誤認しないため)
 */
export async function countInTerminal(page: Page, re: RegExp): Promise<number> {
  const text = await terminalText(page);
  if (!/\$ Compiling /.test(text)) {
    throw new Error(`run の先頭の行が画面から流れていて、ターミナルの出力を数えられない:\n${text}`);
  }
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  return [...text.matchAll(new RegExp(re.source, flags))].length;
}

/**
 * 実行のマーカー (Monaco の squiggly) が付いている行の文字列を、上から順に返す。
 * C / C++ には Monaco 自身の診断が無いので、squiggly は実行のマーカー (parseErrors → resolveMarkerRange) だけ。
 * kind は Monaco のクラス名の severity (`error` / `warning`)
 */
export async function squigglyLines(page: Page, kind: 'error' | 'warning'): Promise<string[]> {
  const tops = await page
    .locator(`.monaco-editor .squiggly-${kind}`)
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
  const viewLines = await page
    .locator('.monaco-editor .view-lines .view-line')
    .evaluateAll((els) =>
      els.map((l) => ({ top: l.getBoundingClientRect().top, text: (l.textContent ?? '').replace(/\u00a0/g, ' ') }))
    );
  return tops
    .sort((a, b) => a - b)
    .map((top) => viewLines.find((l) => Math.abs(l.top - top) < 4)?.text ?? `(no line at ${top})`);
}
