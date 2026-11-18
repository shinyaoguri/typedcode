/**
 * 教材フォルダを読むための注入インタフェース (ADR-0051)。
 *
 * パスは開いた教材フォルダの根からの相対 POSIX パス (`paths.ts`)。本物の実装は
 * File System Access API で開いたフォルダ (#795) が持ち、テストはメモリ上の fake を使う。
 */
export interface WorkspaceReader {
  /** ファイルの内容をテキストで読む。無い・読めないときは reject する。 */
  readText(path: string): Promise<string>;
  /** ファイルがあるか。 */
  exists(path: string): Promise<boolean>;
}
