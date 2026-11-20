/**
 * C / C++ の実行系を、最初に使うときまで読み込まない入口 (#617)。
 *
 * `CExecutor` / `CppExecutor` は `@wasmer/sdk` を静的に import し、初期化で Wasmer の wasm と clang の webc を
 * 取る。この入口は本物を `import()` で読むので、C / C++ を実行しない起動ではそのどれも取らない
 * (静的に import するのは型だけ。ここから本物のモジュールを静的に import しないこと)。
 *
 * 初期化の契約:
 * - 本物の読み込みと初期化は、最初の `initialize()` (= 最初の C / C++ の実行か、/author の検証) で始まる
 * - 並行する `initialize()` は 1 つの Promise にまとめる (読み込みも初期化も 1 回)。進み具合は待っている
 *   全員に届き、途中から加わった呼び出しには最後の進み具合をまず渡す
 * - 失敗 (チャンクの取得・Wasmer の起動・clang の取得) は待っている全員に同じ失敗として返し、まとめた
 *   Promise を捨てる。次の `initialize()` がやり直す (読み込めた本物は持ち続ける)
 * - 停止 (`abort()`) は本物の今の run を止めるだけで、進行中の初期化は止めない。初期化を待つ間に止めた run は
 *   呼び出し側 (`CodeExecutionController` の run の所有) が先へ進めず、続く実行は同じ初期化を待つか、
 *   済んだ結果を使う
 */

import type {
  ExecutorConfig,
  ExecutionCallbacks,
  ExecutionOptions,
  ExecutionResult,
  ILanguageExecutor,
  InitializationProgress,
  ParsedError,
} from '../interfaces/ILanguageExecutor.js';

/** 本物の executor (CExecutor / CppExecutor) のうち、この入口が使う面 */
export interface ClangExecutor extends ILanguageExecutor {
  resetRuntime(): Promise<void>;
}

type ProgressListener = (progress: InitializationProgress) => void;

export class LazyClangExecutor implements ILanguageExecutor {
  /** 読み込んだ本物 (読み込む前は null) */
  private real: ClangExecutor | null = null;
  /** 進行中の読み込み + 初期化 (無ければ null) */
  private pending: Promise<void> | null = null;
  private readonly listeners = new Set<ProgressListener>();
  private lastProgress: InitializationProgress | null = null;

  /**
   * @param config 本物と同じ表示用の設定 (読み込む前に `config.name` を引かれるので、ここで持つ)
   * @param load 本物を読み込む (`import()`)
   */
  constructor(
    readonly config: ExecutorConfig,
    private readonly load: () => Promise<ClangExecutor>
  ) {}

  get isInitialized(): boolean {
    return this.real?.isInitialized ?? false;
  }

  get isInitializing(): boolean {
    return this.pending !== null;
  }

  /** 本物を読み込んだか */
  get isLoaded(): boolean {
    return this.real !== null;
  }

  initialize(onProgress?: ProgressListener): Promise<void> {
    if (!this.pending && this.real?.isInitialized) return Promise.resolve();
    if (onProgress) {
      if (this.pending && this.lastProgress) onProgress(this.lastProgress);
      this.listeners.add(onProgress);
    }
    this.pending ??= this.start();
    const pending = this.pending;
    return onProgress ? pending.finally(() => this.listeners.delete(onProgress)) : pending;
  }

  private start(): Promise<void> {
    const emit = (progress: InitializationProgress): void => {
      this.lastProgress = progress;
      for (const listener of [...this.listeners]) listener(progress);
    };
    return (async () => {
      this.real ??= await this.load();
      await this.real.initialize(emit);
    })().finally(() => {
      this.pending = null;
      this.lastProgress = null;
    });
  }

  run(code: string, callbacks: ExecutionCallbacks, options?: ExecutionOptions): Promise<ExecutionResult> {
    if (!this.real) return Promise.reject(new Error('Executor not initialized. Call initialize() first.'));
    return this.real.run(code, callbacks, options);
  }

  /** 本物の今の run を止める。読み込む前は止めるものが無い (進行中の初期化は止めない) */
  abort(): void {
    this.real?.abort();
  }

  parseErrors(stderr: string): ParsedError[] {
    return this.real?.parseErrors(stderr) ?? [];
  }

  isRuntimeCorrupted(): boolean {
    return this.real?.isRuntimeCorrupted?.() ?? false;
  }

  /** 本物の runtime を作り直す。読み込む前は作り直すものが無いので、読み込みも始めない */
  async resetRuntime(): Promise<void> {
    await this.real?.resetRuntime();
  }

  dispose(): void {
    this.real?.dispose();
  }
}

/** CExecutor の config と同じ値 (読み込まずに引けるよう写しを持つ。一致はユニットテストが見る) */
export const C_EXECUTOR_CONFIG: ExecutorConfig = {
  id: 'c',
  name: 'C',
  fileExtension: '.c',
  monacoLanguage: 'c',
  icon: 'c-icon',
};

/** CppExecutor の config と同じ値 */
export const CPP_EXECUTOR_CONFIG: ExecutorConfig = {
  id: 'cpp',
  name: 'C++',
  fileExtension: '.cpp',
  monacoLanguage: 'cpp',
};

let cInstance: LazyClangExecutor | null = null;
let cppInstance: LazyClangExecutor | null = null;

/** C の実行系の入口 (シングルトン。本物は最初の initialize で読む) */
export function getLazyCExecutor(): LazyClangExecutor {
  cInstance ??= new LazyClangExecutor(C_EXECUTOR_CONFIG, async () => (await import('./CExecutor.js')).getCExecutor());
  return cInstance;
}

/** C++ の実行系の入口 (シングルトン。本物は最初の initialize で読む) */
export function getLazyCppExecutor(): LazyClangExecutor {
  cppInstance ??= new LazyClangExecutor(CPP_EXECUTOR_CONFIG, async () =>
    (await import('../cpp/CppExecutor.js')).getCppExecutor()
  );
  return cppInstance;
}
