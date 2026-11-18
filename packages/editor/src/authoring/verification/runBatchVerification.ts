/**
 * 解答例 × ケースの一括検証 (#802 / ADR-0051 Decision 6 / 仕様 §4.10)。
 *
 * 解答例ごとに、ケースを 1 つずつ順に非対話で実行し、期待の出力と比べる。実行の入口は注入する
 * (既定の入口は `executors/nonInteractive/runNonInteractive.ts`、テストは偽物)。
 * 結果は proof にも教材フォルダにも記録しない (呼び出し側の画面が表示するだけ)。
 *
 * ケースの型は教材フォルダの読み込み (`authoring/workspace/`) とは独立に、ここで要る分だけ持つ。
 */

import type { NonInteractiveRunner } from '../../executors/nonInteractive/runNonInteractive.js';
import { DEFAULT_OUTPUT_MATCH_MODE, type OutputMatchMode, outputsMatch } from './compareOutput.js';

/** 検証する解答例 1 つ */
export interface VerificationSolution {
  /** 表示と対応付けに使う名前 (教材フォルダの相対パスなど) */
  name: string;
  language: string;
  filename: string;
  code: string;
}

/** 検証に使うケース 1 つ */
export interface VerificationCase {
  name: string;
  stdin: string;
  /** 期待する stdout */
  stdout: string;
  /** 比べ方 (省略時は trim) */
  match?: OutputMatchMode;
}

/**
 * セルの判定
 * - `match` / `mismatch`: 正常終了し、stdout が期待と一致した / しなかった
 * - `runtime-error`: コンパイルエラー・非 0 終了・ランタイムの失敗 (stdout は比べない)
 * - `timeout`: 実行時間の上限を超えた
 * - `unsupported`: 非対話の実行に対応しない言語
 */
export type VerificationVerdict = 'match' | 'mismatch' | 'runtime-error' | 'timeout' | 'unsupported';

/** 解答例 × ケースの 1 セル */
export interface VerificationCell {
  solutionIndex: number;
  caseIndex: number;
  solutionName: string;
  caseName: string;
  verdict: VerificationVerdict;
  /** 期待する stdout (ケースのまま) */
  expectedStdout: string;
  /** 実際の stdout */
  actualStdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface BatchVerificationResult {
  /** 終わったセル (解答例の順、その中はケースの順) */
  cells: VerificationCell[];
  /** 中止されて、全セルを走らせずに終わった */
  aborted: boolean;
}

export interface BatchVerificationOptions {
  /** 非対話の実行の入口 */
  run: NonInteractiveRunner;
  /** 中止 (実行中のケースを止め、残りを走らせない) */
  signal?: AbortSignal;
  /** セルが 1 つ終わるたびに呼ぶ */
  onCell?: (cell: VerificationCell) => void;
}

/** 解答例 × ケースを順に走らせ、セルごとの判定を返す */
export async function runBatchVerification(
  solutions: readonly VerificationSolution[],
  cases: readonly VerificationCase[],
  options: BatchVerificationOptions
): Promise<BatchVerificationResult> {
  const { run, signal, onCell } = options;
  const cells: VerificationCell[] = [];

  for (const [solutionIndex, solution] of solutions.entries()) {
    for (const [caseIndex, testCase] of cases.entries()) {
      if (signal?.aborted) return { cells, aborted: true };

      const result = await run(
        { language: solution.language, filename: solution.filename, code: solution.code, stdin: testCase.stdin },
        signal ? { signal } : {}
      );
      // 実行中に中止された (または入口の外から止められた) ケースは結果に入れない
      if (result.outcome === 'aborted' || signal?.aborted) return { cells, aborted: true };

      const cell: VerificationCell = {
        solutionIndex,
        caseIndex,
        solutionName: solution.name,
        caseName: testCase.name,
        verdict: judge(result.outcome, result.stdout, testCase),
        expectedStdout: testCase.stdout,
        actualStdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
      cells.push(cell);
      onCell?.(cell);
    }
  }
  return { cells, aborted: false };
}

function judge(
  outcome: 'success' | 'runtime-error' | 'timeout' | 'unsupported',
  stdout: string,
  testCase: VerificationCase
): VerificationVerdict {
  if (outcome !== 'success') return outcome;
  return outputsMatch(stdout, testCase.stdout, testCase.match ?? DEFAULT_OUTPUT_MATCH_MODE) ? 'match' : 'mismatch';
}
