/**
 * 「追加」で作る新しいファイルの既定の名前 (#796)。
 *
 * `<語幹>-<役割の語><番号>.<拡張子>` (問題定義のあるフォルダからの相対)。役割の語は画面の言語で渡す
 * (日本語なら「初期」「ヒント」「解答」)。番号は同じ役割の 2 つ目から付け、フォルダに同じ名前が在れば進める。
 * ケースは `<語幹>.cases.yaml`。拡張子は、ヒントは `.md`、初期コードと解答例は既にある初期コード / 解答例に合わせ、
 * 無ければ `.c`。
 */

import type { AddableRole, ProblemPart } from '../workspace/authorWorkspace.js';
import { problemIdFromPath, workspaceBasename } from '../workspace/paths.js';
import { dottedExtension } from './fileKinds.js';

export type PartWords = Readonly<Record<Exclude<AddableRole, 'cases'>, string>>;

export interface DefaultPartNameInput {
  /** 問題定義のパス (根からの相対) */
  readonly problemPath: string;
  readonly role: AddableRole;
  readonly words: PartWords;
  /** 問題の今の要素 */
  readonly parts: readonly ProblemPart[];
  /** フォルダのファイル (名前の重なりを避けるため) */
  readonly files: readonly string[];
}

const DEFAULT_CODE_EXTENSION = '.c';

function codeExtension(parts: readonly ProblemPart[]): string {
  for (const role of ['starter', 'solution'] as const) {
    for (const part of parts) {
      if (part.role !== role) continue;
      const ext = dottedExtension(part.path ?? part.reference);
      if (ext !== '') return ext;
    }
  }
  return DEFAULT_CODE_EXTENSION;
}

export function defaultPartName(input: DefaultPartNameInput): string {
  const { problemPath, role, words, parts, files } = input;
  const stem = problemIdFromPath(problemPath);
  const dir = problemPath.slice(0, problemPath.length - workspaceBasename(problemPath).length);
  const taken = new Set(files.map((file) => file.normalize('NFC')));
  const isFree = (name: string): boolean => !taken.has(`${dir}${name}`.normalize('NFC'));

  if (role === 'cases') {
    let name = `${stem}.cases.yaml`;
    for (let n = 2; !isFree(name); n++) name = `${stem}-${n}.cases.yaml`;
    return name;
  }
  const ext = role === 'hint' ? '.md' : codeExtension(parts);
  const word = words[role];
  let n = parts.filter((part) => part.role === role).length + 1;
  const nameFor = (k: number): string => `${stem}-${word}${k > 1 ? k : ''}${ext}`;
  while (!isFree(nameFor(n))) n++;
  return nameFor(n);
}
