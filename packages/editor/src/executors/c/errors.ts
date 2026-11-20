/**
 * C / C++ の実行系のエラー型。
 *
 * `CExecutor.ts` は `@wasmer/sdk` を静的に import するので、エラーの判定 (`instanceof`) のためだけに
 * それを import すると、C / C++ を使わない起動でも Wasmer の SDK が読まれる (#617)。判定する側
 * (`CodeExecutionController`) はこのファイルから import する
 */

/**
 * Error class for unrecoverable Wasmer SDK corruption
 * When this error is thrown, user must reload the page
 */
export class WasmerSdkCorruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WasmerSdkCorruptedError';
  }
}
