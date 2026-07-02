/**
 * CLI 引数の解析と検証 (純関数)。
 *
 * 未知フラグ・タイポ・値欠落を黙って無視すると、`--require-root-anchr` のような
 * タイポでセキュリティゲートが無効のまま exit 0 になる (#148)。フラグは
 * ここのホワイトリストで検証し、cli.ts は結果を使うだけにする。
 * 新しいフラグを足すときは VALUE_FLAGS / BOOLEAN_FLAGS のどちらかに必ず登録する。
 */

/** value を取る flag。`--name value` と `--name=value` の両方を許す。`--analyzer` は反復可。 */
export const VALUE_FLAGS = new Set([
  '--mode',
  '--exam-package',
  '--submitted-at',
  '--analysis-json',
  '--analysis-bundle',
  '--analyzer',
]);

/** 値を取らない boolean flag。`=` 付きは拒否する。 */
export const BOOLEAN_FLAGS = new Set([
  '--require-anchor-density',
  '--require-root-anchor',
  '--no-default-analyzers',
  '--help',
  '-h',
]);

/**
 * フラグ列を検証し、問題があればエラーメッセージを返す (なければ null)。
 * - 未知の `-`/`--` 引数 → エラー (タイポの黙殺防止)
 * - value flag の値欠落 (末尾、または次の引数がフラグ) → エラー
 * - boolean flag への `=` 付与 (`--require-root-anchor=true`) → エラー (黙って無視しない)
 */
export function findFlagError(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('-')) continue;
    if (BOOLEAN_FLAGS.has(arg)) continue;
    if (VALUE_FLAGS.has(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) {
        return `${arg} requires a value.`;
      }
      i++; // 値をスキップ
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      const name = arg.slice(0, eq);
      if (VALUE_FLAGS.has(name)) continue;
      if (BOOLEAN_FLAGS.has(name)) {
        return `${name} does not take a value (got: ${arg}).`;
      }
    }
    return `Unknown option: ${arg}`;
  }
  return null;
}

/** value flag の値を取り出す (`--name value` / `--name=value`)。 */
export function flagValue(args: string[], name: string): string | undefined {
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i === -1) return undefined;
  const arg = args[i]!;
  return arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : args[i + 1];
}

/** 反復可能な value flag の値をすべて集める (`--analyzer a --analyzer b`)。 */
export function flagValues(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === name) {
      const v = args[i + 1];
      if (v !== undefined) out.push(v);
      i++;
    } else if (arg.startsWith(`${name}=`)) {
      out.push(arg.slice(name.length + 1));
    }
  }
  return out;
}

/** フラグとその値を除いた位置引数 (検証対象ファイル)。 */
export function nonFlagArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (VALUE_FLAGS.has(arg)) {
      i++; // skip the flag's value
      continue;
    }
    if (arg.startsWith('-')) continue; // --flag=value or boolean flag (検証済み前提)
    out.push(arg);
  }
  return out;
}
