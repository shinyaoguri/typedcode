/**
 * 解答例 × ケースの一括検証 (#802)。実行の入口は偽物 (コードと stdin から結果を作る) に差し替える。
 * 比較関数は本物を使う。
 */

import { describe, it, expect } from 'vitest';
import type {
  NonInteractiveRequest,
  NonInteractiveResult,
  NonInteractiveRunner,
} from '../../../executors/nonInteractive/runNonInteractive.js';
import {
  runBatchVerification,
  type VerificationCase,
  type VerificationCell,
  type VerificationSolution,
} from '../runBatchVerification.js';

/** 最大値を求める 2 つの解答。`zero-init` は最大値を 0 で初期化する誤り (負数だけで 0 を出す) */
const solutions: VerificationSolution[] = [
  { name: 'max-first.c', language: 'c', filename: 'max-first.c', code: 'first-init' },
  { name: 'max-zero.c', language: 'c', filename: 'max-zero.c', code: 'zero-init' },
];

const cases: VerificationCase[] = [
  { name: 'positive', stdin: '3\n1 8 4\n', stdout: '8\n' },
  { name: 'negative only', stdin: '3\n-5 -2 -8\n', stdout: '-2\n' },
];

/** 偽の入口: code に応じて stdin の 2 行目から最大値を出す */
function fakeProgram(request: NonInteractiveRequest): NonInteractiveResult {
  const numbers = (request.stdin.split('\n')[1] ?? '').split(' ').map(Number);
  const max = request.code === 'zero-init' ? Math.max(0, ...numbers) : Math.max(...numbers);
  return { stdout: `${max}\n`, stderr: '', outcome: 'success', exitCode: 0 };
}

const summary = (cells: readonly VerificationCell[]) =>
  cells.map((c) => `${c.solutionName} × ${c.caseName}: ${c.verdict}`);

describe('runBatchVerification', () => {
  it('returns one cell per solution and case, tied to both and judged against the expected output', async () => {
    const run: NonInteractiveRunner = async (request) => fakeProgram(request);

    const result = await runBatchVerification(solutions, cases, { run });

    expect({ aborted: result.aborted, cells: summary(result.cells) }).toEqual({
      aborted: false,
      cells: [
        'max-first.c × positive: match',
        'max-first.c × negative only: match',
        'max-zero.c × positive: match',
        'max-zero.c × negative only: mismatch',
      ],
    });
  });

  it('gives each cell the indices of its solution and case', async () => {
    const run: NonInteractiveRunner = async (request) => fakeProgram(request);

    const { cells } = await runBatchVerification(solutions, cases, { run });

    expect(cells.map((c) => [c.solutionIndex, c.caseIndex])).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]);
  });

  it('keeps the expected and actual output of a mismatching cell', async () => {
    const run: NonInteractiveRunner = async (request) => fakeProgram(request);

    const { cells } = await runBatchVerification(solutions, cases, { run });

    expect(cells[3]).toMatchObject({
      solutionIndex: 1,
      caseIndex: 1,
      expectedStdout: '-2\n',
      actualStdout: '0\n',
    });
  });

  it('runs each solution with the stdin of each case, one at a time and in order', async () => {
    const calls: string[] = [];
    let running = 0;
    let overlapped = false;
    const run: NonInteractiveRunner = async (request) => {
      running++;
      if (running > 1) overlapped = true;
      calls.push(`${request.code}:${request.stdin}`);
      await Promise.resolve();
      running--;
      return fakeProgram(request);
    };

    await runBatchVerification(solutions, cases, { run });

    expect({ calls, overlapped }).toEqual({
      calls: ['first-init:3\n1 8 4\n', 'first-init:3\n-5 -2 -8\n', 'zero-init:3\n1 8 4\n', 'zero-init:3\n-5 -2 -8\n'],
      overlapped: false,
    });
  });

  it('compares with the match mode of each case', async () => {
    const run: NonInteractiveRunner = async () => ({ stdout: '8  \n', stderr: '', outcome: 'success', exitCode: 0 });
    const modes: VerificationCase[] = [
      { name: 'trim', stdin: '', stdout: '8\n' },
      { name: 'exact', stdin: '', stdout: '8\n', match: 'exact' },
    ];

    const { cells } = await runBatchVerification([solutions[0] as VerificationSolution], modes, { run });

    expect(summary(cells)).toEqual(['max-first.c × trim: match', 'max-first.c × exact: mismatch']);
  });

  it('reports runtime errors, timeouts and unsupported languages without comparing the output', async () => {
    const outcomes = ['runtime-error', 'timeout', 'unsupported'] as const;
    let i = 0;
    const run: NonInteractiveRunner = async () => ({
      stdout: '8\n',
      stderr: 'err',
      outcome: outcomes[i++] ?? 'success',
      exitCode: null,
    });
    const threeCases = [cases[0], cases[0], cases[0]] as VerificationCase[];

    const { cells } = await runBatchVerification([solutions[0] as VerificationSolution], threeCases, { run });

    expect(cells.map((c) => c.verdict)).toEqual(['runtime-error', 'timeout', 'unsupported']);
  });

  it('notifies each cell as soon as it finishes', async () => {
    const notified: string[] = [];
    const run: NonInteractiveRunner = async (request) => {
      notified.push(`run ${request.code}`);
      return fakeProgram(request);
    };

    await runBatchVerification([solutions[0] as VerificationSolution], cases, {
      run,
      onCell: (cell) => notified.push(`cell ${cell.caseName}`),
    });

    expect(notified).toEqual(['run first-init', 'cell positive', 'run first-init', 'cell negative only']);
  });
});

describe('runBatchVerification abort', () => {
  it('stops the running case, runs none of the remaining ones and returns the finished cells', async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const run: NonInteractiveRunner = (request, options) => {
      started.push(`${request.code}:${request.stdin}`);
      if (started.length < 2) return Promise.resolve(fakeProgram(request));
      // 2 つ目のケースの実行中に中止される。入口は signal を見て止まる
      return new Promise((resolve) => {
        options?.signal?.addEventListener('abort', () =>
          resolve({ stdout: '', stderr: '', outcome: 'aborted', exitCode: null })
        );
        controller.abort();
      });
    };

    const result = await runBatchVerification(solutions, cases, { run, signal: controller.signal });

    expect({ aborted: result.aborted, cells: summary(result.cells), started: started.length }).toEqual({
      aborted: true,
      cells: ['max-first.c × positive: match'],
      started: 2,
    });
  });

  it('runs nothing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let runs = 0;
    const run: NonInteractiveRunner = async (request) => {
      runs++;
      return fakeProgram(request);
    };

    const result = await runBatchVerification(solutions, cases, { run, signal: controller.signal });

    expect({ aborted: result.aborted, cells: result.cells.length, runs }).toEqual({ aborted: true, cells: 0, runs: 0 });
  });

  it('stops when a case is stopped from outside the batch, without recording that case', async () => {
    let runs = 0;
    const run: NonInteractiveRunner = async () => {
      runs++;
      return { stdout: '', stderr: '', outcome: 'aborted', exitCode: null };
    };

    const result = await runBatchVerification(solutions, cases, { run });

    expect({ aborted: result.aborted, cells: result.cells.length, runs }).toEqual({ aborted: true, cells: 0, runs: 1 });
  });
});
