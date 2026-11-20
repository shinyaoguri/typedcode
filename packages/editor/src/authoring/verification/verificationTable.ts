/**
 * 教員用の一括検証の結果表の状態 (#799 / ADR-0051 Decision 6)。DOM に触れない。
 *
 * 行 = 解答例、列 = ケース。セルは `pending` (待ち) → `running` (実行中) → 判定 (`VerificationVerdict`) と進む。
 * 実行器 (`runBatchVerification`) は解答例の順 → その中のケースの順に 1 つずつ走らせるので、セルが 1 つ終わるたびに
 * 判定を入れ、次のセルを `running` にする。中止すると、走っていたセルと残りは `pending` のまま、表は `aborted` になる。
 *
 * 表の値は作り直して返す (古い表を書き換えない)。画面はこの値を描くだけ。結果は proof にも教材フォルダにも
 * IndexedDB にも記録しない。
 */

import type { NonInteractiveRunner } from '../../executors/nonInteractive/runNonInteractive.js';
import type { OutputMatchMode } from './compareOutput.js';
import {
  runBatchVerification,
  type VerificationCase,
  type VerificationCell,
  type VerificationSolution,
  type VerificationVerdict,
} from './runBatchVerification.js';

/** セルの状態 */
export type CellStatus = 'pending' | 'running' | VerificationVerdict;

/** 表全体の状態 (`blocked` は表を作らずに理由を出す画面側の状態なので、ここには無い) */
export type TableRunState = 'idle' | 'running' | 'done' | 'aborted';

export interface TableCell {
  readonly solutionIndex: number;
  readonly caseIndex: number;
  readonly status: CellStatus;
  /** 判定が付いたセルの結果 (期待・実際・stderr・終了コード) */
  readonly result: VerificationCell | null;
}

export interface VerificationTable {
  readonly problemPath: string;
  readonly solutions: readonly { readonly name: string; readonly filename: string }[];
  readonly cases: readonly { readonly name: string; readonly match: OutputMatchMode }[];
  /** `cells[solutionIndex][caseIndex]` */
  readonly cells: readonly (readonly TableCell[])[];
  readonly state: TableRunState;
}

/** 全セルが待ちの表を作る */
export function createVerificationTable(
  problemPath: string,
  solutions: readonly VerificationSolution[],
  cases: readonly VerificationCase[]
): VerificationTable {
  return {
    problemPath,
    solutions: solutions.map((solution) => ({ name: solution.name, filename: solution.filename })),
    cases: cases.map((testCase) => ({ name: testCase.name, match: testCase.match ?? 'trim' })),
    cells: solutions.map((_, solutionIndex) =>
      cases.map((_, caseIndex) => ({ solutionIndex, caseIndex, status: 'pending', result: null }))
    ),
    state: 'idle',
  };
}

function withCells(
  table: VerificationTable,
  update: (cell: TableCell) => TableCell,
  state: TableRunState
): VerificationTable {
  return { ...table, cells: table.cells.map((row) => row.map(update)), state };
}

/** (solutionIndex, caseIndex) の次に走るセル (解答例の順 → ケースの順)。最後なら null */
function nextPosition(table: VerificationTable, solutionIndex: number, caseIndex: number): [number, number] | null {
  if (caseIndex + 1 < table.cases.length) return [solutionIndex, caseIndex + 1];
  if (solutionIndex + 1 < table.solutions.length) return [solutionIndex + 1, 0];
  return null;
}

/** 実行を始める: 全セルを待ちに戻し、最初のセルを実行中にする */
export function startTable(table: VerificationTable): VerificationTable {
  return withCells(
    table,
    (cell) => ({
      ...cell,
      status: cell.solutionIndex === 0 && cell.caseIndex === 0 ? 'running' : 'pending',
      result: null,
    }),
    'running'
  );
}

/** 終わったセルの判定を入れ、次のセルを実行中にする */
export function applyCellResult(table: VerificationTable, result: VerificationCell): VerificationTable {
  const next = nextPosition(table, result.solutionIndex, result.caseIndex);
  return withCells(
    table,
    (cell) => {
      if (cell.solutionIndex === result.solutionIndex && cell.caseIndex === result.caseIndex) {
        return { ...cell, status: result.verdict, result };
      }
      if (next && cell.solutionIndex === next[0] && cell.caseIndex === next[1]) return { ...cell, status: 'running' };
      return cell;
    },
    table.state
  );
}

/** 実行を終える。中止なら、走っていたセルを待ちに戻す */
export function finishTable(table: VerificationTable, aborted: boolean): VerificationTable {
  return withCells(
    table,
    (cell) => (cell.status === 'running' ? { ...cell, status: 'pending' } : cell),
    aborted ? 'aborted' : 'done'
  );
}

/** 表を 1 回走らせる。表が変わるたびに `onChange` を呼び、終わった表を返す */
export async function runVerificationTable(
  table: VerificationTable,
  solutions: readonly VerificationSolution[],
  cases: readonly VerificationCase[],
  options: { run: NonInteractiveRunner; signal?: AbortSignal; onChange: (table: VerificationTable) => void }
): Promise<VerificationTable> {
  let current = startTable(table);
  options.onChange(current);
  let aborted: boolean;
  try {
    const result = await runBatchVerification(solutions, cases, {
      run: options.run,
      ...(options.signal ? { signal: options.signal } : {}),
      onCell: (cell) => {
        current = applyCellResult(current, cell);
        options.onChange(current);
      },
    });
    aborted = result.aborted;
  } catch (error) {
    // 入口の例外は表を止めて返す (画面を「実行中」のまま残さない)
    console.error('[verification] run failed:', error);
    aborted = true;
  }
  current = finishTable(current, aborted);
  options.onChange(current);
  return current;
}

/**
 * ターミナルの実行と検証の排他 (#799)。executor は対話の実行と非対話の実行で共有するシングルトンなので、
 * 同時に走らせない。ターミナルの実行は検証の間だけ止め、検証はターミナルの実行中と検証中には始めない。
 */
export class ExecutionLock {
  private terminalRuns = 0;
  private verifying = false;

  get verificationRunning(): boolean {
    return this.verifying;
  }

  get terminalRunning(): boolean {
    return this.terminalRuns > 0;
  }

  /** ターミナルの実行を始めてよいなら数えて true。検証中なら false */
  beginTerminal(): boolean {
    if (this.verifying) return false;
    this.terminalRuns++;
    return true;
  }

  endTerminal(): void {
    if (this.terminalRuns > 0) this.terminalRuns--;
  }

  /** 検証を始めてよいなら true。ターミナルの実行中・検証中なら false */
  beginVerification(): boolean {
    if (this.verifying || this.terminalRuns > 0) return false;
    this.verifying = true;
    return true;
  }

  endVerification(): void {
    this.verifying = false;
  }
}
