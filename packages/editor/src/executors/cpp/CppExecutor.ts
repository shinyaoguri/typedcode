/**
 * C++ Language Executor
 *
 * Extends CExecutor to compile and execute C++ code.
 * Uses the same Clang compiler with C++ specific options.
 */

import { CExecutor, WORKSPACE_DIR } from '../c/CExecutor.js';
import type {
  ExecutorConfig,
  ExecutionCallbacks,
  ExecutionOptions,
  ExecutionResult,
} from '../interfaces/ILanguageExecutor.js';

/**
 * libc++ の版の検査の `#warning` だけを黙らせるヘッダ (#871)。
 *
 * clang の webc は clang 16 と libc++ 19 の組み合わせで (#573)、libc++ の `<__config>` が読む
 * `__configuration/compiler.h` が `#warning "Libc++ only supports Clang 17 and later"` を出す。
 * libc++ のヘッダは system header だが、`#warning` は system header の中でも出る診断で、
 * この検査を止める libc++ のマクロも無い。`-Wno-#warnings` は利用者の `#warning` も消すので使わない。
 *
 * そこで、利用者のソースより前に `-include` でこのヘッダを読ませ、`-W#warnings` を無視させた範囲で
 * `<__config>` を 1 回だけ取り込む。以後の `<__config>` は include guard で読まれないので警告は出ず、
 * pop で診断の状態を戻すので、利用者のコードの `#warning` とほかの警告はそのまま出る。
 * libc++ のヘッダはどれも最初に `<__config>` を読むので、先に取り込んでも利用者のコードの意味は変わらない。
 * `-include` はすべての入力に掛かるので、stdout の支援コード (`STDOUT_SUPPORT_SOURCE`。#709) の翻訳単位の
 * `<stdio.h>` からも出なくなる (支援コードの側では黙らせない)。
 * 版の揃った webc に替わったら (#573) 外してよい
 */
export const LIBCXX_VERSION_WARNING_GUARD = `#pragma clang diagnostic push
#pragma clang diagnostic ignored "-W#warnings"
#include <__config>
#pragma clang diagnostic pop
`;

/** LIBCXX_VERSION_WARNING_GUARD を置くゲストのパス */
export const LIBCXX_VERSION_WARNING_GUARD_PATH = `${WORKSPACE_DIR}/typedcode-libcxx-guard.h`;

/** C++ のコンパイルフラグ (target の後ろに付ける)。C の `C_COMPILE_FLAGS` とは別に持つ (#710) */
const CPP_COMPILE_ARGS: readonly string[] = ['-O2', '-std=c++17', '-include', LIBCXX_VERSION_WARNING_GUARD_PATH];

export class CppExecutor extends CExecutor {
  override readonly config: ExecutorConfig = {
    id: 'cpp',
    name: 'C++',
    fileExtension: '.cpp',
    monacoLanguage: 'cpp',
  };

  override async run(
    code: string,
    callbacks: ExecutionCallbacks,
    execution: ExecutionOptions = {}
  ): Promise<ExecutionResult> {
    return this.runWithOptions(
      code,
      callbacks,
      {
        sourceFile: 'main.cpp',
        // C++ として扱わせるのは拡張子 `.cpp` (ドライバが `-x c++` を cc1 に渡す)。`-xc++` は入力ファイルの
        // 後ろでは効かずに警告だけを出し、前に置いても cc1 とリンクの引数は変わらないので渡さない (#871)。
        // C の固定のフラグ (`C_COMPILE_FLAGS`。#710) は使わない (C++ の規格・警告・最適化は #710 の範囲外で、従来の `-O2`)
        compileArgs: CPP_COMPILE_ARGS,
        extraFiles: { [LIBCXX_VERSION_WARNING_GUARD_PATH]: LIBCXX_VERSION_WARNING_GUARD },
      },
      execution
    );
  }
}

// Singleton instance
let executorInstance: CppExecutor | null = null;

/**
 * Get the singleton CppExecutor instance
 */
export function getCppExecutor(): CppExecutor {
  if (!executorInstance) {
    executorInstance = new CppExecutor();
  }
  return executorInstance;
}
