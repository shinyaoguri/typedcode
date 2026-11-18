/**
 * ケースファイルのフォームの状態 (`casesForm.ts`) のテスト (#798)。操作がケースファイルのテキストへ書き戻され、
 * 触っていないケースと欄の値・コメントが元のまま残ること、名前が空・重複のときにテキストを作らないこと、
 * 末尾の改行の数え方を固定する。
 */

import { describe, expect, it } from 'vitest';
import {
  applyCasesFormOp,
  type CasesFormOp,
  containsCarriageReturn,
  countTrailingNewlines,
  duplicateCaseName,
  nextCaseName,
} from '../casesForm.js';
import { type CaseDefinition, parseCasesDefinition } from '../definitions.js';

const TEXT = [
  'format: tc-cases/1',
  'cases:',
  '  # 例 1 のコメント',
  '  - name: 例1',
  '    stdin: "3\\n1 8 4\\n"',
  '    stdout: "8\\n"',
  '    public: true',
  '  # CRLF のケース',
  '  - name: 改行',
  '    stdin: "a\\r\\nb\\r\\n"',
  '    stdout: "  x\\n\\n"',
  '    match: exact',
  '  # 最後のケース',
  '  - name: 最後',
  '    stdin: ""',
  '    stdout: "z"',
  '    note: 未知のキー',
  '',
].join('\n');

function cases(text: string): CaseDefinition[] {
  const parsed = parseCasesDefinition(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.value;
}

function apply(text: string, op: CasesFormOp): { text: string; selected: number } {
  const result = applyCasesFormOp(text, op);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result;
}

const ORIGINAL = cases(TEXT);

describe('applyCasesFormOp', () => {
  it('appends an empty case with the given name and selects it, leaving the other cases unchanged', () => {
    const result = apply(TEXT, { kind: 'add', name: 'ケース 4' });
    expect(cases(result.text)).toEqual([
      ...ORIGINAL,
      { name: 'ケース 4', stdin: '', stdout: '', public: false, match: 'trim' },
    ]);
    expect(result.selected).toBe(3);
  });

  it('inserts a duplicate right after the original with the same values, public flag and match', () => {
    const result = apply(TEXT, { kind: 'duplicate', index: 1, name: '改行 (2)' });
    expect(cases(result.text)).toEqual([ORIGINAL[0], ORIGINAL[1], { ...ORIGINAL[1], name: '改行 (2)' }, ORIGINAL[2]]);
    expect(result.selected).toBe(2);
  });

  it('removes a case in the middle and keeps each remaining comment and unknown key on its own case', () => {
    const result = apply(TEXT, { kind: 'remove', index: 1 });
    expect(cases(result.text)).toEqual([ORIGINAL[0], ORIGINAL[2]]);
    expect(result.text).not.toContain('CRLF のケース');
    // 最後のケースのコメントと未知のキーは、消したケースの位置へずれずに最後のケースに付いたまま
    expect(result.text).toMatch(/# 最後のケース\n\s+- name: 最後\n[\s\S]*note: 未知のキー/);
    expect(result.text).toContain('# 例 1 のコメント');
  });

  it('selects the previous case after removing the last one, and -1 after removing the only one', () => {
    expect(apply(TEXT, { kind: 'remove', index: 2 }).selected).toBe(1);
    const single = 'format: tc-cases/1\ncases:\n  - name: a\n    stdin: ""\n    stdout: ""\n';
    const result = apply(single, { kind: 'remove', index: 0 });
    expect(cases(result.text)).toEqual([]);
    expect(result.selected).toBe(-1);
  });

  it('changes only the named field and leaves every other value, including CRLF values, byte-for-byte', () => {
    const renamed = apply(TEXT, { kind: 'edit', index: 1, patch: { name: '改行あり' } });
    expect(cases(renamed.text)).toEqual([ORIGINAL[0], { ...ORIGINAL[1], name: '改行あり' }, ORIGINAL[2]]);
    expect(cases(renamed.text)[1]!.stdin).toBe('a\r\nb\r\n');
    expect(renamed.text).toContain('# CRLF のケース');

    const toggled = apply(TEXT, { kind: 'edit', index: 0, patch: { public: false, match: 'exact' } });
    expect(cases(toggled.text)).toEqual([{ ...ORIGINAL[0], public: false, match: 'exact' }, ORIGINAL[1], ORIGINAL[2]]);
  });

  it('writes stdin with leading spaces, blank lines and two trailing newlines exactly as given', () => {
    const value = '  先頭に空白\n\n\tタブ\n \n\n';
    const result = apply(TEXT, { kind: 'edit', index: 2, patch: { stdin: value } });
    expect(cases(result.text)[2]!.stdin).toBe(value);
  });

  it('returns the text unchanged when the edit does not change any value', () => {
    expect(apply(TEXT, { kind: 'edit', index: 0, patch: { name: '例1' } }).text).toBe(TEXT);
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
  ])('refuses a %s name without producing text', (_, name) => {
    for (const op of [
      { kind: 'add', name },
      { kind: 'duplicate', index: 0, name },
      { kind: 'edit', index: 0, patch: { name } },
    ] as const) {
      expect(applyCasesFormOp(TEXT, op)).toEqual({ ok: false, error: { kind: 'empty-name' } });
    }
  });

  it('refuses a name used by another case without producing text, but accepts renaming a case to its own name', () => {
    expect(applyCasesFormOp(TEXT, { kind: 'edit', index: 0, patch: { name: '最後' } })).toEqual({
      ok: false,
      error: { kind: 'duplicate-name', name: '最後' },
    });
    expect(applyCasesFormOp(TEXT, { kind: 'add', name: '例1' })).toEqual({
      ok: false,
      error: { kind: 'duplicate-name', name: '例1' },
    });
    expect(applyCasesFormOp(TEXT, { kind: 'edit', index: 2, patch: { name: '最後' } }).ok).toBe(true);
  });

  it('refuses an index outside the cases', () => {
    expect(applyCasesFormOp(TEXT, { kind: 'remove', index: 3 })).toEqual({
      ok: false,
      error: { kind: 'out-of-range', index: 3 },
    });
  });

  it('refuses to touch a cases file that cannot be read', () => {
    const result = applyCasesFormOp('format: tc-cases/1\ncases: [\n', { kind: 'add', name: 'a' });
    expect(result.ok === false && result.error.kind).toBe('invalid-definition');
  });
});

describe('case names', () => {
  const format = (n: number) => `ケース ${n}`;
  const copy = (base: string, n: number) => `${base} (${n})`;
  const named = (...names: string[]) => names.map((name) => ({ ...ORIGINAL[0]!, name }));

  it('numbers a new case after the count, skipping names already used', () => {
    expect(nextCaseName([], format)).toBe('ケース 1');
    expect(nextCaseName(named('a', 'b'), format)).toBe('ケース 3');
    expect(nextCaseName(named('ケース 2', 'ケース 3'), format)).toBe('ケース 4');
  });

  it('numbers a duplicate from 2, skipping names already used', () => {
    expect(duplicateCaseName(named('例1'), '例1', copy)).toBe('例1 (2)');
    expect(duplicateCaseName(named('例1', '例1 (2)', '例1 (3)'), '例1', copy)).toBe('例1 (4)');
  });
});

describe('countTrailingNewlines', () => {
  it.each([
    ['', 0],
    ['a', 0],
    ['a\n', 1],
    ['a\n\n', 2],
    ['\n', 1],
    ['a\nb', 0],
    ['a\r\n', 1],
    ['a\r\n\r\n', 2],
    ['a\n\r\n', 2],
    ['a\r', 1],
  ])('counts %j as %i trailing newlines', (value, count) => {
    expect(countTrailingNewlines(value)).toBe(count);
  });
});

describe('containsCarriageReturn', () => {
  it('detects CRLF and lone CR but not LF-only values', () => {
    expect(containsCarriageReturn('a\r\nb')).toBe(true);
    expect(containsCarriageReturn('a\rb')).toBe(true);
    expect(containsCarriageReturn('a\nb\n')).toBe(false);
  });
});
