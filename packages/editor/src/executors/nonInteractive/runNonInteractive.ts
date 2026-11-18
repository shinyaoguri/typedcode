/**
 * 非対話の実行の入口 (#802 / ADR-0051 Decision 6 / 仕様 §4.10)。
 *
 * 教員用の一括検証が使う。ターミナル (`CodeExecutionController` の対話の経路) を通さず、executor に
 * stdin の全体を渡して EOF を送り、stdout と stderr を別々の文字列に集めて返す。proof には記録しない。
 *
 * - 対応言語は C / C++ / Python。それ以外は実行せず `unsupported` を返す
 * - 1 ケースの実行時間の上限は `NON_INTERACTIVE_TIMEOUT_MS` (正本はこの定数)。利用者のプログラムが
 *   動き始めたとき (`onProgramStart`) から数え、ランタイムの読み込みとコンパイルは数えない
 * - 上限を超えたとき・中止されたときは、既存の停止の経路 (`executor.abort()`) で止め、run の終わりを
 *   待たずに結果を確定する。C / C++ は Process の kill と次の run での runtime の作り直し、Python は
 *   Worker の terminate (どちらも停止ボタンと同じ)
 * - 対話の実行 (ターミナル) の上限は変えない (C / C++ には今も無い)
 */

import type { ILanguageExecutor } from '../interfaces/ILanguageExecutor.js';
import { getCExecutor } from '../c/CExecutor.js';
import { getCppExecutor } from '../cpp/CppExecutor.js';
import { getPythonExecutor } from '../python/PythonExecutor.js';

/** 非対話の実行 1 回 (1 ケース) の実行時間の上限 (ミリ秒)。ADR-0051 Decision 6 の値の正本 */
export const NON_INTERACTIVE_TIMEOUT_MS = 10_000;

/** 非対話の実行に対応する言語 */
export const NON_INTERACTIVE_LANGUAGES: readonly string[] = ['c', 'cpp', 'python'];

export interface NonInteractiveRequest {
  language: string;
  filename: string;
  code: string;
  /** プログラムに渡す stdin の全体 (渡し切ったら EOF) */
  stdin: string;
}

/**
 * 実行の終わり方
 * - `success`: 正常終了 (終了コード 0)
 * - `runtime-error`: 実行時エラー (コンパイルエラー・非 0 終了・ランタイムの初期化の失敗を含む)
 * - `timeout`: 上限を超えて打ち切った
 * - `aborted`: 中止された
 * - `unsupported`: 非対話の実行に対応しない言語 (実行していない)
 */
export type NonInteractiveOutcome = 'success' | 'runtime-error' | 'timeout' | 'aborted' | 'unsupported';

export interface NonInteractiveResult {
  /** プログラムの stdout を取りこぼさず連結したもの (stderr は混ぜない) */
  stdout: string;
  /** コンパイラの診断・プログラムの stderr・実行系のエラー */
  stderr: string;
  outcome: NonInteractiveOutcome;
  /** 終了コード。プログラムが自分で終わらなかったとき (timeout / aborted / unsupported / 実行系の例外) は null */
  exitCode: number | null;
}

/** タイマーを仕掛け、取り消す関数を返す (時計の注入口。既定は setTimeout) */
export type ScheduleTimer = (callback: () => void, ms: number) => () => void;

export interface NonInteractiveOptions {
  /** 中止 (実行中なら止める) */
  signal?: AbortSignal;
  /** 実行時間の上限 (既定 NON_INTERACTIVE_TIMEOUT_MS) */
  timeoutMs?: number;
  /**
   * 言語から executor を引く (既定は対話の実行と共有するシングルトン)。null は未対応。
   * 対話の実行との排他は呼び出し側 (#799 の画面) が決める
   */
  resolveExecutor?: (language: string) => ILanguageExecutor | null;
  /** 時計 (テストで差し替える) */
  schedule?: ScheduleTimer;
}

/** 非対話の実行の入口の形 (一括の実行器はこれを注入して受ける) */
export type NonInteractiveRunner = (
  request: NonInteractiveRequest,
  options?: Pick<NonInteractiveOptions, 'signal'>
) => Promise<NonInteractiveResult>;

/** 既定の executor の引き方 (対応言語だけ) */
export function defaultNonInteractiveExecutor(language: string): ILanguageExecutor | null {
  switch (language) {
    case 'c':
      return getCExecutor();
    case 'cpp':
      return getCppExecutor();
    case 'python':
      return getPythonExecutor();
    default:
      return null;
  }
}

const defaultSchedule: ScheduleTimer = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** stdin を渡してプログラムを 1 回走らせ、stdout / stderr と終わり方を返す */
export async function runNonInteractive(
  request: NonInteractiveRequest,
  options: NonInteractiveOptions = {}
): Promise<NonInteractiveResult> {
  const { signal } = options;
  const timeoutMs = options.timeoutMs ?? NON_INTERACTIVE_TIMEOUT_MS;
  const schedule = options.schedule ?? defaultSchedule;
  const resolveExecutor = options.resolveExecutor ?? defaultNonInteractiveExecutor;

  if (!NON_INTERACTIVE_LANGUAGES.includes(request.language)) {
    return { stdout: '', stderr: '', outcome: 'unsupported', exitCode: null };
  }
  const executor = resolveExecutor(request.language);
  if (!executor) return { stdout: '', stderr: '', outcome: 'unsupported', exitCode: null };
  if (signal?.aborted) return { stdout: '', stderr: '', outcome: 'aborted', exitCode: null };

  let stdout = '';
  let stderr = '';

  return new Promise<NonInteractiveResult>((resolve) => {
    let settled = false;
    let cancelTimer: (() => void) | null = null;
    /** run を始めたか (始める前の中止は executor を止めなくてよい) */
    let started = false;

    const finish = (outcome: NonInteractiveOutcome, exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      cancelTimer?.();
      cancelTimer = null;
      signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, outcome, exitCode });
    };

    /** 結果を先に確定してから止める (停止の通知 "[System] Program stopped." を stderr に入れない) */
    const stop = (outcome: 'timeout' | 'aborted'): void => {
      if (settled) return;
      finish(outcome, null);
      if (!started) return;
      try {
        executor.abort();
      } catch (error) {
        console.error('[runNonInteractive] abort failed:', error);
      }
    };

    const onAbort = (): void => stop('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });

    const execute = async (): Promise<void> => {
      if (!executor.isInitialized) {
        try {
          await executor.initialize();
        } catch (error) {
          if (!settled) stderr += `${errorMessage(error)}\n`;
          finish('runtime-error', null);
          return;
        }
      }
      if (settled) return;

      started = true;
      try {
        const result = await executor.run(
          request.code,
          {
            onStdout: (text) => {
              if (!settled) stdout += text;
            },
            onStderr: (text) => {
              if (!settled) stderr += text;
            },
            onProgramStart: () => {
              if (settled || cancelTimer) return;
              cancelTimer = schedule(() => stop('timeout'), timeoutMs);
            },
          },
          { stdin: request.stdin, showLastValue: false }
        );
        if (settled) return;
        switch (result.outcome) {
          case 'timeout':
            // executor 自身の上限 (Python の 60 秒) に先に達した
            finish('timeout', null);
            return;
          case 'aborted':
            // この入口以外 (ターミナルの停止ボタンなど) から止められた
            finish('aborted', null);
            return;
          default:
            if (result.success) finish('success', result.exitCode);
            else {
              if (result.error && !stderr) stderr = result.error;
              finish('runtime-error', result.exitCode);
            }
        }
      } catch (error) {
        if (!settled) stderr += `${errorMessage(error)}\n`;
        finish('runtime-error', null);
      }
    };

    void execute();
  });
}
