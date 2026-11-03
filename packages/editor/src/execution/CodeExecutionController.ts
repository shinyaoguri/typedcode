/**
 * CodeExecutionController - コード実行の制御
 * 言語に応じたExecutorの選択、実行、中断を管理
 */

import type { ILanguageExecutor, ParsedError } from '../executors/interfaces/ILanguageExecutor.js';
import type { CTerminal } from '../terminal/CTerminal.js';
import type { CodeExecutionEventData, CodeExecutionOutcome, EventType } from '@typedcode/shared';
import { getCExecutor, WasmerSdkCorruptedError } from '../executors/c/CExecutor.js';
import { getCppExecutor } from '../executors/cpp/CppExecutor.js';
import { getJavaScriptExecutor } from '../executors/javascript/JavaScriptExecutor.js';
import { getTypeScriptExecutor } from '../executors/typescript/TypeScriptExecutor.js';
import { getPythonExecutor } from '../executors/python/PythonExecutor.js';
import { getExecutionLimits } from '../executors/sandbox/limits.js';
import { t } from '../i18n/index.js';

/** 実行可能な言語 */
export const EXECUTABLE_LANGUAGES = ['c', 'cpp', 'javascript', 'typescript', 'python'];

/** コンパイル型言語 */
const COMPILED_LANGUAGES = ['c', 'cpp'];

/** ランタイム状態 */
export type RuntimeState = 'not-ready' | 'loading' | 'ready';

export interface CodeExecutionCallbacks {
  onRunStart?: () => void;
  onRunEnd?: () => void;
  onNotification?: (message: string) => void;
  onRuntimeStatusChange?: (language: string, status: RuntimeState) => void;
  onShowClangLoading?: () => void;
  onHideClangLoading?: () => void;
  onUpdateClangStatus?: (message: string) => void;
  onRecordEvent?: (event: { type: EventType; data?: CodeExecutionEventData; description: string }) => void;
  onShowErrors?: (errors: ParsedError[]) => void;
  onClearErrors?: () => void;
}

export interface ExecutionTarget {
  language: string;
  filename: string;
  code: string;
}

export class CodeExecutionController {
  private terminal: CTerminal | null = null;
  private currentExecutor: ILanguageExecutor | null = null;
  private isRunning = false;
  /** 実行中の中断を結果イベントとして記録する (ADR-0021)。run() が設定し finally で破棄。 */
  private recordAbortedResult: (() => void) | null = null;
  /** run の通し番号 (ターミナルの `data-exec-run` にも出す) */
  private runSeq = 0;
  /** 今の run の番号。停止・終了で null。古い run はこれと比べて自分が今の run かを知る */
  private activeRunId: number | null = null;
  private callbacks: CodeExecutionCallbacks = {};

  /**
   * ターミナルを設定
   */
  setTerminal(terminal: CTerminal): void {
    this.terminal = terminal;
  }

  /**
   * コールバックを設定
   */
  setCallbacks(callbacks: CodeExecutionCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * 言語に対応するExecutorを取得
   */
  private getExecutorForLanguage(language: string): ILanguageExecutor | null {
    switch (language) {
      case 'c':
        return getCExecutor();
      case 'cpp':
        return getCppExecutor();
      case 'javascript':
        return getJavaScriptExecutor();
      case 'typescript':
        return getTypeScriptExecutor();
      case 'python':
        return getPythonExecutor();
      default:
        return null;
    }
  }

  /**
   * 言語が実行可能かチェック
   */
  isExecutable(language: string): boolean {
    return EXECUTABLE_LANGUAGES.includes(language);
  }

  /**
   * コンパイル型言語かチェック
   */
  private isCompiled(language: string): boolean {
    return COMPILED_LANGUAGES.includes(language);
  }

  /**
   * 実行中かどうか
   */
  get running(): boolean {
    return this.isRunning;
  }

  /**
   * コードを実行
   *
   * run ごとに通し番号を持ち、状態 (isRunning / currentExecutor / recordAbortedResult) の更新と
   * ターミナルへの出力は「自分が今の run のときだけ」行う (#290)。停止 → 即再実行で、古い run の
   * 遅れた出力や finally が新しい run を壊さない (古い run の出力は新しい run のターミナルに出ない、
   * 新しい run を停止できる)。実行系の例外はここで止め、editor・保存・export へ伝播させない。
   */
  async run(target: ExecutionTarget): Promise<void> {
    if (this.isRunning) {
      this.callbacks.onNotification?.(t('notifications.alreadyRunning'));
      return;
    }

    if (!this.isExecutable(target.language)) {
      this.callbacks.onNotification?.(t('notifications.languageNotExecutable', { language: target.language }));
      return;
    }

    const executor = this.getExecutorForLanguage(target.language);
    if (!executor) {
      this.callbacks.onNotification?.(t('notifications.runtimeNotFound', { language: target.language }));
      return;
    }

    const runId = ++this.runSeq;
    this.activeRunId = runId;
    const isCurrent = (): boolean => this.activeRunId === runId;

    // Check if runtime needs recovery (for C/C++ after forced stop)
    const needsRecovery = executor.isRuntimeCorrupted?.() ?? false;

    this.currentExecutor = executor;
    this.isRunning = true;
    this.callbacks.onRunStart?.();
    this.callbacks.onClearErrors?.();

    const isCompiled = this.isCompiled(target.language);
    const langName = executor.config.name;

    this.terminal?.clear();
    this.terminal?.markRunStarted(runId);

    // Show recovery message if needed
    if (needsRecovery) {
      this.terminal?.writeInfo('$ Recovering from previous error...\n');
      this.callbacks.onRuntimeStatusChange?.(target.language, 'loading');
    }

    if (isCompiled) {
      this.terminal?.writeInfo(`$ Compiling ${langName} program (${target.filename})...\n`);
    } else {
      this.terminal?.writeInfo(`$ Running ${langName} (${target.filename})...\n`);
    }

    // コード実行イベントを記録 (ADR-0021: start / result の 2 イベント)
    const executionStartedAt = performance.now();
    this.callbacks.onRecordEvent?.({
      type: 'codeExecution',
      data: {
        phase: 'start',
        filename: target.filename,
        language: target.language,
      },
      description: t('notifications.codeExecution', { filename: target.filename }),
    });

    // 実行結果を記録する (ADR-0021)。catch/abort を含む全終端経路から 1 回だけ呼ぶ。
    let resultRecorded = false;
    const recordResult = (outcome: CodeExecutionOutcome, exitCode: number | null): void => {
      if (resultRecorded) return;
      resultRecorded = true;
      this.terminal?.markRunFinished(outcome);
      this.callbacks.onRecordEvent?.({
        type: 'codeExecution',
        data: {
          phase: 'result',
          filename: target.filename,
          language: target.language,
          outcome,
          exitCode,
          elapsedMs: Math.round(performance.now() - executionStartedAt),
        },
        description: `${target.filename}: ${outcome}${exitCode !== null ? ` (exit ${exitCode})` : ''}`,
      });
    };
    this.recordAbortedResult = () => recordResult('aborted', null);

    try {
      // 初回は初期化
      if (!executor.isInitialized) {
        if (isCompiled) {
          this.callbacks.onShowClangLoading?.();
        }
        this.callbacks.onRuntimeStatusChange?.(target.language, 'loading');

        await executor.initialize((progress) => {
          if (!isCurrent()) return;
          if (isCompiled) {
            this.callbacks.onUpdateClangStatus?.(progress.message);
          }
          this.terminal?.writeInfo(progress.message + '\n');
        });

        this.callbacks.onRuntimeStatusChange?.(target.language, 'ready');
        if (isCompiled) {
          this.callbacks.onHideClangLoading?.();
        }
      }

      // 初期化を待つ間に停止された run は実行しない
      if (!isCurrent()) return;

      const result = await executor.run(target.code, {
        onStdout: (text: string) => {
          if (isCurrent()) this.terminal?.write(text);
        },
        onStderr: (text: string) => {
          if (!isCurrent()) return;
          this.terminal?.writeError(text);
          const errors = executor.parseErrors(text) ?? [];
          if (errors.length > 0) {
            this.callbacks.onShowErrors?.(errors);
          }
        },
        onStdinReady: (stdinStream: WritableStream<Uint8Array>) => {
          if (isCurrent()) this.terminal?.connectStdin(stdinStream);
        },
        onProgress: (msg: string) => {
          if (isCurrent()) this.terminal?.writeInfo(msg + '\n');
        },
      });

      // 停止済み (abort が aborted を記録済み) の run は、結果も表示も新しい run に任せる
      if (result && isCurrent()) {
        const outcome = result.outcome ?? (result.success ? 'success' : 'failure');
        this.writeOutcome(langName, outcome, result.exitCode, result.error);
        const exitCode = outcome === 'success' || outcome === 'failure' ? (result.exitCode ?? null) : null;
        recordResult(outcome, exitCode);
      }
    } catch (error) {
      console.error('[CodeExecutionController] Execution error:', error);
      if (!isCurrent()) return;
      this.callbacks.onHideClangLoading?.();

      // Handle unrecoverable Wasmer SDK corruption
      if (error instanceof WasmerSdkCorruptedError) {
        this.terminal?.writeError(
          '\n[System] The WebAssembly runtime is corrupted and cannot be recovered.\n' +
            '[System] Please reload the page to continue using the C/C++ compiler.\n'
        );
        this.callbacks.onRuntimeStatusChange?.(target.language, 'not-ready');
      } else {
        this.terminal?.writeError('Execution error: ' + error + '\n');
      }
      this.callbacks.onNotification?.(t('notifications.executionFailed'));
      recordResult('error', null);
    } finally {
      // 今の run のときだけ状態を戻す (停止 → 再実行の後の古い run は何も書かない)
      if (isCurrent()) {
        // abort 経路 (recordAbortedResult) を含め、未記録なら記録漏れを塞ぐ。
        recordResult('error', null);
        this.recordAbortedResult = null;
        this.isRunning = false;
        this.currentExecutor = null;
        this.activeRunId = null;
        this.terminal?.disconnectStdin();
        this.callbacks.onRunEnd?.();
      }
    }
  }

  /** 実行の終わり方をターミナルに 1 行で出す (英語固定。既存の `execution aborted` と同じ流儀) */
  private writeOutcome(langName: string, outcome: CodeExecutionOutcome, exitCode: number, error?: string): void {
    switch (outcome) {
      case 'success':
        this.terminal?.writeSuccess(`\n$ ${langName} exited with code ${exitCode}\n`);
        return;
      case 'failure':
        this.terminal?.writeError(`\n$ ${langName} failed with code ${exitCode}\n`);
        return;
      case 'timeout':
        this.terminal?.writeError(
          `\n$ ${langName} execution timed out after ${Math.round(getExecutionLimits().timeoutMs / 1000)}s\n`
        );
        return;
      case 'aborted':
        this.terminal?.writeError(`\n$ ${langName} execution aborted\n`);
        return;
      case 'error':
        this.terminal?.writeError(`\n$ ${langName} execution error${error ? `: ${error}` : ''}\n`);
        return;
    }
  }

  /**
   * 実行を中断
   */
  abort(): void {
    if (this.currentExecutor && this.isRunning) {
      const langName = this.currentExecutor.config.name;
      const recordAborted = this.recordAbortedResult;
      // 先に「今の run」を外す: 以後この run の出力・finally は状態に触れない
      this.activeRunId = null;
      this.recordAbortedResult = null;
      this.isRunning = false;
      const executor = this.currentExecutor;
      this.currentExecutor = null;
      try {
        executor.abort();
      } catch (error) {
        console.error('[CodeExecutionController] abort failed:', error);
      }
      this.terminal?.disconnectStdin();
      this.terminal?.writeError(`\n$ ${langName} execution aborted\n`);
      // ADR-0021: 中断も結果として記録する (run() の finally より先に確定させる)
      recordAborted?.();
      this.callbacks.onRunEnd?.();
    }
  }

  /**
   * リソースを解放
   */
  dispose(): void {
    this.abort();
    this.terminal = null;
    this.callbacks = {};
  }
}
