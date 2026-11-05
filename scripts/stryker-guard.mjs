#!/usr/bin/env node
/**
 * 変異検査 (`npm run mutate -w @typedcode/shared`) を始める前の検査 (#600)。
 *
 * stryker.config.json は `inPlace: true` で、実行中は `packages/shared/src` を直接書き換え、
 * 元のファイルを `packages/shared/.stryker-tmp/backup-*` に退避する (ADR-0040)。正常に終われば
 * 元へ戻して `.stryker-tmp` ごと消える。したがって `.stryker-tmp` が既にあるのは次のどちらか:
 *
 * - 別のプロセスが同じ作業ツリーで変異検査を走らせている (重ねるとソースの退避と復元が混ざる)
 * - 前の実行が途中で止まった残骸 (`backup-*` があれば、ソースに変異が残っている恐れ)
 *
 * どちらでも変異を始めずに止める。並行するエージェントが同じ worktree で変異の入ったソースを
 * 読む・テストする・コミットする事故を、入口で塞ぐため。
 *
 * 実行: shared の `mutate` スクリプトが `node ../../scripts/stryker-guard.mjs && stryker run` と
 * 呼ぶ (cwd は packages/shared)。引数でディレクトリを渡せる (テスト用)。
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Stryker が作業ファイルと退避を置くディレクトリ名 (Stryker の既定値。.gitignore 済み)。 */
export const STRYKER_TMP = '.stryker-tmp';

/**
 * `.stryker-tmp` の状態を調べる。
 * @param {string} packageDir 変異検査を走らせるパッケージのディレクトリ
 * @returns {{ state: 'clear' } | { state: 'busy' | 'leftover', tmpDir: string, backups: string[] }}
 */
export function inspectStrykerTmp(packageDir) {
  const tmpDir = join(packageDir, STRYKER_TMP);
  if (!existsSync(tmpDir)) return { state: 'clear' };
  const backups = readdirSync(tmpDir).filter((name) => name.startsWith('backup-'));
  // backup-* は実行中にも存在するので、実行中か残骸かはここでは区別できない。
  // backup-* が無い `.stryker-tmp` (sandbox や作業ファイルだけ) は、ソースを書き換えていない段階か残骸。
  return { state: backups.length > 0 ? 'leftover' : 'busy', tmpDir, backups };
}

/**
 * 止める理由の文面を作る。止めなくてよいなら null。
 * @param {ReturnType<typeof inspectStrykerTmp>} result
 * @returns {string | null}
 */
export function guardMessage(result) {
  if (result.state === 'clear') return null;
  const lines = [
    `[stryker-guard] ${result.tmpDir} が既にあるので、変異検査を始めません (#600)。`,
    '別のプロセスがこの作業ツリーで変異検査を走らせているか、前の実行が途中で止まった残骸です。',
    '走っているなら終わるのを待ってください (`pgrep -fl stryker` で確かめられます)。',
  ];
  if (result.state === 'leftover') {
    const backup = result.backups.map((name) => join(result.tmpDir, name)).join(', ');
    lines.push(
      `走っていないなら、元のファイルが ${backup} に退避されたまま、ソースに変異が残っている恐れがあります。`,
      '戻し方は CONTRIBUTING.md「変異検査」の「途中で止まったとき」を見てください。'
    );
  } else {
    lines.push(
      '走っていないなら、ソースは書き換えられていないので、このディレクトリを消してから実行し直してください。'
    );
  }
  return lines.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const message = guardMessage(inspectStrykerTmp(resolve(process.argv[2] ?? process.cwd())));
  if (message) {
    console.error(message);
    process.exit(1);
  }
}
