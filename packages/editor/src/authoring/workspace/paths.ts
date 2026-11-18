/**
 * 教材フォルダ内のパス (ADR-0051 / system-spec §4.10)。
 *
 * パスはすべて **開いた教材フォルダの根からの相対 POSIX パス** で表す (先頭に `/` を付けない。
 * 例 `過去問/探索.problem.yaml`)。フォルダ I/O (#795) と共有する約束。
 * 定義ファイルに書かれた参照は「それを書いた定義ファイルからの相対パス」なので、
 * `resolveWorkspaceReference` で根からの相対パスへ直してから読む。
 */

/** 参照を拒否した理由。 */
export type ReferenceRejection =
  /** 空、または解決するとフォルダそのもの (ファイルを指さない) */
  | 'empty'
  /** `/abs.md`・`C:/x.md` のような絶対パス */
  | 'absolute'
  /** 区切りに `\` を使っている (区切りは `/` だけ) */
  | 'backslash'
  /** `..` で開いたフォルダの外に出る */
  | 'outside-root';

export type ResolveReferenceResult = { ok: true; path: string } | { ok: false; reason: ReferenceRejection };

/** ドライブ文字で始まる (`C:` / `c:/`) パス。 */
const DRIVE_LETTER = /^[A-Za-z]:/;

/** 問題定義のファイル名の接尾辞。 */
const PROBLEM_SUFFIX = '.problem.yaml';

/**
 * 定義ファイルのパスと、その中に書かれた参照から、根からの相対パスを求める。
 * 根の中に収まる `..` (`過去問/x.problem.yaml` から `../共通.md`) は許す。
 */
export function resolveWorkspaceReference(definitionPath: string, reference: string): ResolveReferenceResult {
  if (reference.trim() === '') return { ok: false, reason: 'empty' };
  if (reference.includes('\\')) return { ok: false, reason: 'backslash' };
  if (reference.startsWith('/') || DRIVE_LETTER.test(reference)) return { ok: false, reason: 'absolute' };

  const segments = dirSegments(definitionPath);
  for (const segment of reference.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return { ok: false, reason: 'outside-root' };
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) return { ok: false, reason: 'empty' };
  return { ok: true, path: segments.join('/') };
}

/** パスの最後の要素 (ファイル名)。 */
export function workspaceBasename(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

/** 問題定義のファイル名の語幹 (`過去問/探索.problem.yaml` → `探索`)。作成時に `id` に書く値。 */
export function problemIdFromPath(path: string): string {
  const name = workspaceBasename(path);
  if (name.endsWith(PROBLEM_SUFFIX)) return name.slice(0, -PROBLEM_SUFFIX.length);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function dirSegments(path: string): string[] {
  const parts = path.split('/').filter((s) => s !== '' && s !== '.');
  parts.pop();
  return parts;
}
