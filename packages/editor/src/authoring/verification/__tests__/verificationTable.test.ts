/**
 * 検証の結果表の状態 (#799)。実行の入口は偽物 (`fakeRunner.ts`)、比較と一括の実行器は本物を使う。
 */

import { describe, expect, it } from 'vitest';
import type { VerificationCase, VerificationSolution } from '../runBatchVerification.js';
import { createFakeVerificationRunner } from '../fakeRunner.js';
import {
  applyCellResult,
  createVerificationTable,
  ExecutionLock,
  finishTable,
  runVerificationTable,
  startTable,
  type VerificationTable,
} from '../verificationTable.js';

const solutions: VerificationSolution[] = [
  { name: 'a/first.c', language: 'c', filename: 'first.c', code: '' },
  { name: 'a/zero.c', language: 'c', filename: 'zero.c', code: '' },
];
const cases: VerificationCase[] = [
  { name: 'pos', stdin: 'p', stdout: '8\n' },
  { name: 'neg', stdin: 'n', stdout: '-2\n', match: 'exact' },
];

const statuses = (table: VerificationTable) => table.cells.map((row) => row.map((cell) => cell.status));

function cellOf(solutionIndex: number, caseIndex: number, verdict: 'match' | 'mismatch') {
  return {
    solutionIndex,
    caseIndex,
    solutionName: solutions[solutionIndex]!.name,
    caseName: cases[caseIndex]!.name,
    verdict,
    expectedStdout: '',
    actualStdout: '',
    stderr: '',
    exitCode: 0,
  };
}

describe('verification table', () => {
  it('starts idle with every cell pending, rows for solutions and columns for cases', () => {
    const table = createVerificationTable('p.problem.yaml', solutions, cases);
    expect([table.state, statuses(table), table.cases.map((c) => c.match)]).toEqual([
      'idle',
      [
        ['pending', 'pending'],
        ['pending', 'pending'],
      ],
      ['trim', 'exact'],
    ]);
  });

  it('starting marks only the first cell as running', () => {
    const table = startTable(createVerificationTable('p', solutions, cases));
    expect([table.state, statuses(table)]).toEqual([
      'running',
      [
        ['running', 'pending'],
        ['pending', 'pending'],
      ],
    ]);
  });

  it('a finished cell gets its verdict and the next cell in solution-then-case order becomes running', () => {
    let table = startTable(createVerificationTable('p', solutions, cases));
    table = applyCellResult(table, cellOf(0, 0, 'match'));
    table = applyCellResult(table, cellOf(0, 1, 'mismatch'));
    expect(statuses(table)).toEqual([
      ['match', 'mismatch'],
      ['running', 'pending'],
    ]);
  });

  it('finishing after an abort puts the running cell back to pending and marks the table aborted', () => {
    let table = startTable(createVerificationTable('p', solutions, cases));
    table = applyCellResult(table, cellOf(0, 0, 'match'));
    table = finishTable(table, true);
    expect([table.state, statuses(table)]).toEqual([
      'aborted',
      [
        ['match', 'pending'],
        ['pending', 'pending'],
      ],
    ]);
  });

  it('running fills every cell from the runner and reports each change', async () => {
    const fake = createFakeVerificationRunner([
      { filename: 'first.c', stdin: 'p', stdout: '8\n' },
      { filename: 'first.c', stdin: 'n', stdout: '-2\n' },
      { filename: 'zero.c', stdin: 'p', stdout: '8\n' },
      { filename: 'zero.c', stdin: 'n', stdout: '0\n' },
    ]);
    const seen: string[] = [];
    const done = await runVerificationTable(createVerificationTable('p', solutions, cases), solutions, cases, {
      run: fake.run,
      onChange: (table) => seen.push(`${table.state}:${statuses(table).flat().join(',')}`),
    });
    expect([done.state, statuses(done), done.cells[1]![1]!.result?.actualStdout]).toEqual([
      'done',
      [
        ['match', 'match'],
        ['match', 'mismatch'],
      ],
      '0\n',
    ]);
    expect(seen).toEqual([
      'running:running,pending,pending,pending',
      'running:match,running,pending,pending',
      'running:match,match,running,pending',
      'running:match,match,match,running',
      'running:match,match,match,mismatch',
      'done:match,match,match,mismatch',
    ]);
  });

  it('aborting while a cell hangs leaves it and the rest pending and runs nothing more', async () => {
    const fake = createFakeVerificationRunner([
      { filename: 'first.c', stdin: 'p', stdout: '8\n' },
      { filename: 'first.c', stdin: 'n', hang: true },
      { filename: 'zero.c', stdout: '8\n' },
    ]);
    const controller = new AbortController();
    const finished = runVerificationTable(createVerificationTable('p', solutions, cases), solutions, cases, {
      run: fake.run,
      signal: controller.signal,
      onChange: (table) => {
        // 次のセルの実行が始まって (止まって) から中止する
        if (table.cells[0]![1]!.status === 'running') setTimeout(() => controller.abort(), 0);
      },
    });
    const done = await finished;
    expect([done.state, statuses(done), fake.calls().length]).toEqual([
      'aborted',
      [
        ['match', 'pending'],
        ['pending', 'pending'],
      ],
      2,
    ]);
  });

  it('a runner that throws ends the table instead of leaving it running', async () => {
    const done = await runVerificationTable(createVerificationTable('p', solutions, cases), solutions, cases, {
      run: async () => {
        throw new Error('boom');
      },
      onChange: () => undefined,
    });
    expect([done.state, statuses(done).flat()]).toEqual(['aborted', ['pending', 'pending', 'pending', 'pending']]);
  });
});

describe('ExecutionLock', () => {
  it('does not start a verification while the terminal is running', () => {
    const lock = new ExecutionLock();
    lock.beginTerminal();
    expect(lock.beginVerification()).toBe(false);
  });

  it('does not start a terminal run while verifying', () => {
    const lock = new ExecutionLock();
    lock.beginVerification();
    expect(lock.beginTerminal()).toBe(false);
  });

  it('does not start a second verification while one is running', () => {
    const lock = new ExecutionLock();
    lock.beginVerification();
    expect(lock.beginVerification()).toBe(false);
  });

  it('allows each again once the other has ended', () => {
    const lock = new ExecutionLock();
    lock.beginTerminal();
    lock.endTerminal();
    const verified = lock.beginVerification();
    lock.endVerification();
    expect([verified, lock.beginTerminal()]).toEqual([true, true]);
  });
});
