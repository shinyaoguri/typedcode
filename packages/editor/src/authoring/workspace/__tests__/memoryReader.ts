import type { WorkspaceReader } from '../reader.js';

/** テスト用のメモリ上の教材フォルダ。`unreadable` に入れたパスは exists が true で readText が reject する。 */
export function memoryReader(files: Record<string, string>, unreadable: readonly string[] = []): WorkspaceReader {
  const map = new Map(Object.entries(files));
  return {
    async readText(path) {
      if (unreadable.includes(path)) throw new Error(`cannot read ${path}`);
      const text = map.get(path);
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return text;
    },
    async exists(path) {
      return map.has(path) || unreadable.includes(path);
    },
  };
}
