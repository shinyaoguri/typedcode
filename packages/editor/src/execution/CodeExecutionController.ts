/**
 * CodeExecutionController - コード実行の制御
 * 言語に応じたExecutorの選択、実行、中断を管理
 */

import type { ILanguageExecutor, ParsedError } from '../executors/interfaces/ILanguageExecutor.js';
import type { CTerminal } from '../terminal/CTerminal.js';
import type { EventType } from '@typedcode/shared';
import { getCExecutor, WasmerSdkCorruptedError } from '../executors/c/CExecutor.js';
import { getCppExecutor } from '../executors/cpp/CppExecutor.js';
import { getJavaScriptExecutor } from '../executors/javascript/JavaScriptExecutor.js';
import { getTypeScriptExecutor } from '../executors/typescript/TypeScriptExecutor.js';
import { getPythonExecutor } from '../executors/python/PythonExecutor.js';
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
  onRecordEvent?: (event: { type: EventType; description: string }) => void;
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

    // Check if runtime needs recovery (for C/C++ after forced stop)
    const needsRecovery = executor.isRuntimeCorrupted?.() ?? false;

    this.currentExecutor = executor;
    this.isRunning = true;
    this.callbacks.onRunStart?.();
    this.callbacks.onClearErrors?.();

    const isCompiled = this.isCompiled(target.language);
    const langName = executor.config.name;

    this.terminal?.clear();

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

    // コード実行イベントを記録
    this.callbacks.onRecordEvent?.({
      type: 'codeExecution',
      description: t('notifications.codeExecution', { filename: target.filename }),
    });

    try {
      // 初回は初期化
      if (!executor.isInitialized) {
        if (isCompiled) {
          this.callbacks.onShowClangLoading?.();
        }
        this.callbacks.onRuntimeStatusChange?.(target.language, 'loading');

        await executor.initialize((progress) => {
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

      const result = await executor.run(target.code, {
        onStdout: (text: string) => this.terminal?.write(text),
        onStderr: (text: string) => {
          this.terminal?.writeError(text);
          const errors = executor.parseErrors(text) ?? [];
          if (errors.length > 0) {
            this.callbacks.onShowErrors?.(errors);
          }
        },
        onStdinReady: (stdinStream: WritableStream<Uint8Array>) => {
          this.terminal?.connectStdin(stdinStream);
        },
        onProgress: (msg: string) => this.terminal?.writeInfo(msg + '\n'),
      });

      if (result) {
        if (result.success) {
          this.terminal?.writeSuccess(`\n$ ${langName} exited with code ${result.exitCode}\n`);
        } else {
          this.terminal?.writeError(`\n$ ${langName} failed with code ${result.exitCode}\n`);
        }
      }
    } catch (error) {
      console.error('[CodeExecutionController] Execution error:', error);
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
    } finally {
      this.isRunning = false;
      this.currentExecutor = null;
      this.terminal?.disconnectStdin();
      this.callbacks.onRunEnd?.();
    }
  }

  /**
   * 実行を中断
   */
  abort(): void {
    if (this.currentExecutor && this.isRunning) {
      const langName = this.currentExecutor.config.name;
      this.currentExecutor.abort();
      this.terminal?.disconnectStdin();
      this.terminal?.writeError(`\n$ ${langName} execution aborted\n`);
      this.isRunning = false;
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
