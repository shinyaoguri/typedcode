/**
 * JavaScript Language Executor
 *
 * ユーザーの JS を opaque origin の sandbox iframe の中の Worker で実行する (#290 / ADR-0041)。
 * エディタの realm では eval しない (親 DOM・localStorage・proof の IndexedDB・`/author` の
 * 秘密鍵に届かせない / 同期の無限ループでエディタを止めない)。停止・タイムアウト・出力予算の超過は
 * iframe ごと除去して終わらせる (SandboxRunner)。console の代替・行番号の補正は Worker 側
 * (sandbox/workerSource.ts) が持つ。
 */

import { BaseExecutor } from '../base/BaseExecutor.js';
import type {
  ExecutorConfig,
  ExecutionCallbacks,
  ExecutionResult,
  InitializationProgress,
  ParsedError,
} from '../interfaces/ILanguageExecutor.js';
import { SandboxRunner, type SandboxResult, type SandboxRun } from '../sandbox/SandboxRunner.js';

/** sandbox の結果を ExecutionResult に写す (outcome はそのまま載せ、Controller が記録に使う) */
export function toExecutionResult(result: SandboxResult): ExecutionResult {
  const success = result.outcome === 'success';
  return {
    success,
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    outcome: result.outcome,
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

export class JavaScriptExecutor extends BaseExecutor {
  readonly config: ExecutorConfig = {
    id: 'javascript',
    name: 'JavaScript',
    fileExtension: '.js',
    monacoLanguage: 'javascript',
  };

  /** 実行中の run (停止の対象)。run ごとに iframe と Worker が別なので、前の run と混ざらない */
  private currentRun: SandboxRun | null = null;

  constructor(private readonly runner: SandboxRunner = new SandboxRunner()) {
    super();
  }

  protected async _doInitialize(onProgress?: (progress: InitializationProgress) => void): Promise<void> {
    // 実行環境は run ごとに作るので、ここで用意するものは無い
    onProgress?.({
      stage: 'ready',
      message: 'JavaScript engine ready!',
      percentage: 100,
    });
  }

  async run(code: string, callbacks: ExecutionCallbacks): Promise<ExecutionResult> {
    if (!this._initialized) {
      throw new Error('JavaScriptExecutor not initialized. Call initialize() first.');
    }

    this.resetAbort();
    callbacks.onProgress?.('Running JavaScript...');

    const run = this.runner.start(code, { onStdout: callbacks.onStdout, onStderr: callbacks.onStderr });
    this.currentRun = run;
    try {
      return toExecutionResult(await run.result);
    } finally {
      // 停止 → 即再実行で、古い run の後始末が新しい run を消さないようにする
      if (this.currentRun === run) this.currentRun = null;
    }
  }

  protected _onAbort(): void {
    this.currentRun?.abort();
  }

  parseErrors(stderr: string): ParsedError[] {
    return parseJavaScriptErrors(stderr);
  }

  override dispose(): void {
    super.dispose();
    this.currentRun?.abort();
    this.currentRun = null;
  }
}

/**
 * 実行時エラーの出力 (`TypeError: ... (at line N, column M)`) からエディタのマーカーを作る。
 * 行・列は出力の時点でユーザーコードの位置に直してあるので、ここでは引き算しない。
 * 読むのは executor 自身が出す `(at line N, column M)` の形だけ (ユーザーが console に出した
 * スタックの文字列からはマーカーを作らない)。最初の 1 件だけを返す。
 */
export function parseJavaScriptErrors(stderr: string): ParsedError[] {
  const match = /^(.*?)\s*\(at line (\d+), column (\d+)\)\s*$/m.exec(stderr);
  if (!match?.[2] || !match[3]) return [];
  const message = (match[1] ?? '').trim() || 'JavaScript Error';
  return [
    {
      line: Math.max(1, parseInt(match[2], 10)),
      column: Math.max(1, parseInt(match[3], 10)),
      severity: 'error',
      message,
    },
  ];
}

// Singleton instance
let executorInstance: JavaScriptExecutor | null = null;

/**
 * Get the singleton JavaScriptExecutor instance
 */
export function getJavaScriptExecutor(): JavaScriptExecutor {
  if (!executorInstance) {
    executorInstance = new JavaScriptExecutor();
  }
  return executorInstance;
}
