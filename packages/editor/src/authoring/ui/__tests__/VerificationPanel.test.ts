// @vitest-environment happy-dom
/**
 * 検証のパネル (#799) の状態契約 (E2E が読む data-*) と、教材・実行結果の文字列を HTML にしないこと、差分の表し方を
 * 固定する。表の状態は verificationTable.ts の純関数で作る。
 */

import { describe, expect, it, vi } from 'vitest';
import type { VerificationCase, VerificationSolution } from '../../verification/runBatchVerification.js';
import {
  applyCellResult,
  createVerificationTable,
  finishTable,
  startTable,
  type VerificationTable,
} from '../../verification/verificationTable.js';
import { t } from '../../../i18n/index.js';
import { VerificationPanel } from '../VerificationPanel.js';

const solutions: VerificationSolution[] = [
  { name: '解答/<b>zero</b>.c', language: 'c', filename: '<b>zero</b>.c', code: '' },
];
const cases: VerificationCase[] = [
  { name: '<i>neg</i>', stdin: '', stdout: '-2\n7\n' },
  { name: 'exact', stdin: '', stdout: 'a\n', match: 'exact' },
];

function doneTable(): VerificationTable {
  let table = startTable(createVerificationTable('max.problem.yaml', solutions, cases));
  table = applyCellResult(table, {
    solutionIndex: 0,
    caseIndex: 0,
    solutionName: solutions[0]!.name,
    caseName: cases[0]!.name,
    verdict: 'mismatch',
    expectedStdout: '-2\n7\n',
    actualStdout: '0  \n',
    stderr: '<script>warn</script>',
    exitCode: 0,
  });
  return table;
}

function mount() {
  const handlers = { onStart: vi.fn(), onAbort: vi.fn() };
  const panel = new VerificationPanel(handlers);
  document.body.replaceChildren(panel.element);
  return { panel, handlers };
}

const cells = (panel: VerificationPanel) =>
  [...panel.element.querySelectorAll<HTMLElement>('[data-verify-cell]')].map((cell) => [
    cell.dataset.solutionIndex,
    cell.dataset.caseIndex,
    cell.dataset.verdict,
  ]);

describe('VerificationPanel', () => {
  it('starts idle without a problem and with start and abort disabled', () => {
    const { panel } = mount();
    const start = panel.element.querySelector<HTMLButtonElement>('[data-action="verify-start"]')!;
    const abort = panel.element.querySelector<HTMLButtonElement>('[data-action="verify-abort"]')!;
    expect([
      panel.element.dataset.verifyState,
      panel.element.dataset.problemPath,
      start.disabled,
      abort.disabled,
    ]).toEqual(['idle', undefined, true, true]);
  });

  it('shows each cell with its indices and verdict, and the table state on the panel', () => {
    const { panel } = mount();
    panel.showTable('最大値', doneTable());
    expect([panel.element.dataset.verifyState, panel.element.dataset.problemPath, cells(panel)]).toEqual([
      'running',
      'max.problem.yaml',
      [
        ['0', '0', 'mismatch'],
        ['0', '1', 'running'],
      ],
    ]);
  });

  it('enables only abort while running and only start when finished', () => {
    const { panel, handlers } = mount();
    const start = panel.element.querySelector<HTMLButtonElement>('[data-action="verify-start"]')!;
    const abort = panel.element.querySelector<HTMLButtonElement>('[data-action="verify-abort"]')!;
    panel.showTable('最大値', doneTable());
    const running = [start.disabled, abort.disabled];
    abort.click();
    panel.showTable('最大値', finishTable(doneTable(), true));
    start.click();
    expect([running, [start.disabled, abort.disabled], panel.element.dataset.verifyState]).toEqual([
      [true, false],
      [false, true],
      'aborted',
    ]);
    expect([handlers.onAbort.mock.calls.length, handlers.onStart.mock.calls.length]).toEqual([1, 1]);
  });

  it('puts names and outputs in as text, not HTML', () => {
    const { panel } = mount();
    panel.showTable('最大値', doneTable());
    panel.element.querySelector<HTMLElement>('[data-verify-cell][data-case-index="0"]')!.click();
    expect([
      panel.element.querySelectorAll('b, i:not(.fas), script').length,
      panel.element.querySelector('tbody th')!.textContent,
      panel.element.querySelector('[data-detail="stderr"]')!.textContent,
    ]).toEqual([0, '<b>zero</b>.c', '<script>warn</script>']);
  });

  it('selecting a cell shows expected and actual line by line with the differing lines marked', () => {
    const { panel } = mount();
    panel.showTable('最大値', doneTable());
    panel.element.querySelector<HTMLElement>('[data-verify-cell][data-case-index="0"]')!.click();
    const detail = panel.element.querySelector<HTMLElement>('#author-verify-detail')!;
    const rows = [...detail.querySelectorAll<HTMLElement>('[data-diff-line]')].map((row) => [
      row.dataset.diff,
      row.querySelector('[data-diff-side="expected"]')!.textContent,
      row.querySelector('[data-diff-side="actual"]')!.textContent,
    ]);
    expect([detail.dataset.solutionIndex, detail.dataset.caseIndex, rows]).toEqual([
      '0',
      '0',
      [
        ['different', '-2', '0··'],
        ['different', '7', t('author.verify.detail.noLine')],
      ],
    ]);
  });

  it('marks the selected cell as pressed', () => {
    const { panel } = mount();
    panel.showTable('最大値', doneTable());
    panel.element.querySelector<HTMLElement>('[data-verify-cell][data-case-index="0"]')!.click();
    const pressed = [...panel.element.querySelectorAll<HTMLElement>('[data-verify-cell]')].map((cell) =>
      cell.getAttribute('aria-pressed')
    );
    expect(pressed).toEqual(['true', 'false']);
  });

  it('shows a missing final newline in the actual output', () => {
    const { panel } = mount();
    let table = startTable(createVerificationTable('p', solutions, cases));
    table = applyCellResult(table, {
      solutionIndex: 0,
      caseIndex: 1,
      solutionName: '',
      caseName: 'exact',
      verdict: 'mismatch',
      expectedStdout: 'a\n',
      actualStdout: 'a',
      stderr: '',
      exitCode: 0,
    });
    panel.showTable('p', finishTable(table, false));
    panel.element.querySelector<HTMLElement>('[data-verify-cell][data-case-index="1"]')!.click();
    const actual = panel.element.querySelector('[data-diff-line="0"] [data-diff-side="actual"]')!.textContent;
    expect(actual).toBe(`a${t('author.verify.detail.noNewline')}`);
  });

  it('blocked shows the reason and no table', () => {
    const { panel } = mount();
    panel.showTable('最大値', doneTable());
    panel.showBlocked('max.problem.yaml', '最大値', 'no-solutions', '解答例がありません。');
    expect([
      panel.element.dataset.verifyState,
      panel.element.dataset.verifyReason,
      panel.element.querySelectorAll('[data-verify-cell]').length,
      panel.element.querySelector('#author-verify-message')!.textContent,
    ]).toEqual(['blocked', 'no-solutions', 0, '解答例がありません。']);
  });
});
