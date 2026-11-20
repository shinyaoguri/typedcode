import { describe, expect, it } from 'vitest';
import {
  type CaseInput,
  createCasesDefinitionText,
  createExamDefinitionText,
  createProblemDefinitionText,
  parseCasesDefinition,
  parseExamDefinition,
  parseProblemDefinition,
  type SerializeResult,
  updateCasesDefinitionText,
  updateExamDefinitionText,
  updateProblemDefinitionText,
} from '../definitions.js';
import { problemIdFromPath } from '../paths.js';

function textOf(result: SerializeResult): string {
  if (!result.ok) throw new Error(`serialize failed: ${JSON.stringify(result.issues)}`);
  return result.text;
}

const PROBLEM_WITH_COMMENTS = `# 数列の最大値の問題
format: tc-problem/1
id: 最大値 # 改名で変えない
statement: 最大値.md
solutions: [最大値-解答.c] # 解答例
grader-note: 採点メモ # アプリの知らないキー
`;

/**
 * 往復させる値 (受け入れ条件 1)。後半の空白だけの行からなる値は、yaml 2.9 に書き方を任せると
 * `|+` になって読み戻しで値が変わる罠 (definitions.ts の stabilizeCaseStrings が二重引用符へ逃がす)。
 */
const TRICKY_VALUES: [string, string][] = [
  ['empty string', ''],
  ['leading and trailing spaces', '  3\n1 8 4  '],
  ['blank line in the middle', '3\n\n1 8 4\n'],
  ['no trailing newline', '8'],
  ['one trailing newline', '8\n'],
  ['two trailing newlines', '8\n\n'],
  ['three trailing newlines', '8\n\n\n'],
  ['CRLF line endings', '3\r\n1 8 4\r\n'],
  ['tabs', '\ta\tb\n'],
  ['whitespace-only lines between content', '  \n \nx\n \n'],
  ['a single whitespace-only line', ' \n'],
  ['only whitespace-only lines', '  \n \n'],
  ['a whitespace-only line followed by an empty line', ' \n\n'],
  ['only newlines', '\n\n'],
  ['long lines that the writer might fold', `${'a '.repeat(70)}\n ${'b '.repeat(70)}\n`],
  ['a long line without spaces', `${'w'.repeat(200)}  ${'q'.repeat(100)} `],
  ['YAML-looking content', '# not a comment\n- not a list\nkey: value\n'],
];

describe('cases: stdin / stdout round-trip', () => {
  it.each(TRICKY_VALUES)('preserves %s exactly through create then parse', (_label, value) => {
    const text = textOf(createCasesDefinitionText([{ name: 'c', stdin: value, stdout: value }]));
    const parsed = parseCasesDefinition(text);
    expect(parsed.ok && [parsed.value[0]!.stdin, parsed.value[0]!.stdout]).toEqual([value, value]);
  });

  it.each(TRICKY_VALUES)('preserves %s exactly when an existing case is updated to it', (_label, value) => {
    const original = textOf(createCasesDefinitionText([{ name: 'c', stdin: 'x\n', stdout: 'y\n' }]));
    const text = textOf(updateCasesDefinitionText(original, [{ name: 'c', stdin: value, stdout: value }]));
    const parsed = parseCasesDefinition(text);
    expect(parsed.ok && [parsed.value[0]!.stdin, parsed.value[0]!.stdout]).toEqual([value, value]);
  });
});

describe('cases: parse rules', () => {
  it('defaults public to false and match to trim', () => {
    const parsed = parseCasesDefinition('format: tc-cases/1\ncases:\n  - name: a\n    stdin: ""\n    stdout: ""\n');
    expect(parsed.ok && { public: parsed.value[0]!.public, match: parsed.value[0]!.match }).toEqual({
      public: false,
      match: 'trim',
    });
  });

  it('rejects a duplicated case name within one file and names the offending key', () => {
    const parsed = parseCasesDefinition(
      'format: tc-cases/1\ncases:\n  - {name: a, stdin: "", stdout: ""}\n  - {name: a, stdin: "", stdout: ""}\n'
    );
    expect(parsed).toEqual({ ok: false, issues: [{ kind: 'duplicate-case-name', key: 'cases[1].name', name: 'a' }] });
  });

  it('rejects an empty case name', () => {
    const parsed = parseCasesDefinition('format: tc-cases/1\ncases:\n  - {name: " ", stdin: "", stdout: ""}\n');
    expect(parsed).toEqual({
      ok: false,
      issues: [{ kind: 'invalid-type', key: 'cases[0].name', expected: 'non-empty-string' }],
    });
  });

  it('rejects a match value other than trim or exact', () => {
    const parsed = parseCasesDefinition(
      'format: tc-cases/1\ncases:\n  - {name: a, stdin: "", stdout: "", match: fuzzy}\n'
    );
    expect(parsed).toEqual({
      ok: false,
      issues: [{ kind: 'invalid-value', key: 'cases[0].match', allowed: ['trim', 'exact'] }],
    });
  });

  it('rejects a non-string stdout instead of coercing it', () => {
    const parsed = parseCasesDefinition('format: tc-cases/1\ncases:\n  - {name: a, stdin: "", stdout: 8}\n');
    expect(parsed).toEqual({
      ok: false,
      issues: [{ kind: 'invalid-type', key: 'cases[0].stdout', expected: 'string' }],
    });
  });

  it('collects issues from every case rather than stopping at the first', () => {
    const parsed = parseCasesDefinition(
      'format: tc-cases/1\ncases:\n  - {name: a, stdin: ""}\n  - {stdin: "", stdout: ""}\n'
    );
    expect(parsed.ok ? [] : parsed.issues.map((i) => (i.kind === 'missing-key' ? i.key : i.kind))).toEqual([
      'cases[0].stdout',
      'cases[1].name',
    ]);
  });

  it('refuses to create a cases file whose names collide', () => {
    const cases: CaseInput[] = [
      { name: 'a', stdin: '', stdout: '' },
      { name: 'a', stdin: '', stdout: '' },
    ];
    expect(createCasesDefinitionText(cases).ok).toBe(false);
  });

  it('writes public and match only when they differ from the defaults', () => {
    const text = textOf(
      createCasesDefinitionText([
        { name: 'a', stdin: '', stdout: '' },
        { name: 'b', stdin: '', stdout: '', public: true, match: 'exact' },
      ])
    );
    expect([text.match(/public:/g)?.length, text.match(/match:/g)?.length]).toEqual([1, 1]);
  });

  it('keeps comments and unknown keys of untouched cases when a case is appended', () => {
    const original =
      'format: tc-cases/1\ncases:\n  # 境界\n  - name: a\n    stdin: ""\n    stdout: ""\n    weight: 2 # 配点\n';
    const text = textOf(
      updateCasesDefinitionText(original, [
        { name: 'a', stdin: '', stdout: '' },
        { name: 'b', stdin: '1\n', stdout: '1\n', public: true },
      ])
    );
    expect(['# 境界', 'weight: 2 # 配点', 'name: b'].every((s) => text.includes(s))).toBe(true);
  });

  it('drops trailing cases that are no longer in the list', () => {
    const original = textOf(
      createCasesDefinitionText([
        { name: 'a', stdin: '', stdout: '' },
        { name: 'b', stdin: '', stdout: '' },
      ])
    );
    const parsed = parseCasesDefinition(
      textOf(updateCasesDefinitionText(original, [{ name: 'a', stdin: '', stdout: '' }]))
    );
    expect(parsed.ok && parsed.value.map((c) => c.name)).toEqual(['a']);
  });

  it('removes public and match keys when a case returns to the defaults', () => {
    const original = textOf(
      createCasesDefinitionText([{ name: 'a', stdin: '', stdout: '', public: true, match: 'exact' }])
    );
    const text = textOf(updateCasesDefinitionText(original, [{ name: 'a', stdin: '', stdout: '' }]));
    expect(/public:|match:/.test(text)).toBe(false);
  });

  it('builds each case from the original node named by sources, using an original node at most once', () => {
    const original =
      'format: tc-cases/1\ncases:\n  - name: a\n    stdin: ""\n    stdout: ""\n    weight: 1\n  - name: b # 2 件目\n    stdin: ""\n    stdout: ""\n';
    // b を先頭へ、a は 2 回 (2 回目は新しい節点なので未知のキーを持たない)
    const text = textOf(
      updateCasesDefinitionText(
        original,
        [
          { name: 'b', stdin: '', stdout: '' },
          { name: 'a', stdin: '', stdout: '' },
          { name: 'a2', stdin: '', stdout: '' },
        ],
        [1, 0, 0]
      )
    );
    expect(text.indexOf('# 2 件目')).toBeLessThan(text.indexOf('name: a'));
    expect(text.match(/weight: 1/g)?.length).toBe(1);
    const parsed = parseCasesDefinition(text);
    expect(parsed.ok && parsed.value.map((c) => c.name)).toEqual(['b', 'a', 'a2']);
  });
});

describe('problem definitions', () => {
  it('keeps comments and unknown keys when one solution is appended', () => {
    const text = textOf(
      updateProblemDefinitionText(PROBLEM_WITH_COMMENTS, { solutions: ['最大値-解答.c', '最大値-別解.c'] })
    );
    const kept = [
      '# 数列の最大値の問題',
      '# 改名で変えない',
      '# 解答例',
      'grader-note: 採点メモ # アプリの知らないキー',
    ];
    expect(kept.filter((s) => !text.includes(s))).toEqual([]);
  });

  it('writes the appended solution so that it reads back', () => {
    const text = textOf(
      updateProblemDefinitionText(PROBLEM_WITH_COMMENTS, { solutions: ['最大値-解答.c', '最大値-別解.c'] })
    );
    const parsed = parseProblemDefinition(text);
    expect(parsed.ok && parsed.value.solutions).toEqual(['最大値-解答.c', '最大値-別解.c']);
  });

  it('keeps a flow-style list in flow style when it is edited', () => {
    const text = textOf(
      updateProblemDefinitionText(PROBLEM_WITH_COMMENTS, { solutions: ['最大値-解答.c', '最大値-別解.c'] })
    );
    expect(text).toMatch(/^solutions: \[最大値-解答\.c, 最大値-別解\.c\]/m);
  });

  it('returns the original text byte for byte when the patch repeats current values', () => {
    // 描き直すと揃ってしまう書き方 (コロンの後の余分な空白・flow の内側の空白) を含めておく
    const original = 'format: tc-problem/1\nid:   最大値\nstatement: 最大値.md\nhints: [ a.md ]\n';
    const text = textOf(updateProblemDefinitionText(original, { id: '最大値', hints: ['a.md'] }));
    expect(text).toBe(original);
  });

  it('keeps the trailing comment of a scalar whose value is changed', () => {
    const text = textOf(updateProblemDefinitionText(PROBLEM_WITH_COMMENTS, { id: '最大値2' }));
    expect(text).toContain('id: 最大値2 # 改名で変えない');
  });

  it('removes an optional key when the patch sets it to undefined', () => {
    const text = textOf(updateProblemDefinitionText(PROBLEM_WITH_COMMENTS, { solutions: undefined }));
    expect(text.includes('solutions')).toBe(false);
  });

  it('rejects reading a file whose format is a newer version and reports the found format', () => {
    const parsed = parseProblemDefinition('format: tc-problem/99\nid: a\nstatement: a.md\n');
    expect(parsed).toEqual({
      ok: false,
      issues: [{ kind: 'unsupported-format', found: 'tc-problem/99', expected: 'tc-problem/1' }],
    });
  });

  it('refuses to write back over a file whose format is unknown', () => {
    const result = updateProblemDefinitionText('format: tc-problem/99\nid: a\nstatement: a.md\n', { title: 'x' });
    expect(result.ok).toBe(false);
  });

  it('reports broken YAML with its line instead of throwing', () => {
    const parsed = parseProblemDefinition('format: tc-problem/1\nhints: [a.md\n');
    expect(parsed.ok === false && parsed.issues[0]!.kind === 'yaml-syntax' && parsed.issues[0]!.line).toBe(3);
  });

  it('reports a document that is not a mapping', () => {
    expect(parseProblemDefinition('- a\n- b\n')).toEqual({ ok: false, issues: [{ kind: 'not-a-mapping' }] });
  });

  it('reports a missing format key', () => {
    expect(parseProblemDefinition('id: a\nstatement: a.md\n')).toEqual({
      ok: false,
      issues: [{ kind: 'missing-key', key: 'format' }],
    });
  });

  it('reports every missing or mistyped key at once', () => {
    const parsed = parseProblemDefinition('format: tc-problem/1\nhints: a.md\n');
    expect(parsed).toEqual({
      ok: false,
      issues: [
        { kind: 'missing-key', key: 'id' },
        { kind: 'missing-key', key: 'statement' },
        { kind: 'invalid-type', key: 'hints', expected: 'string-list' },
      ],
    });
  });

  it('creates a definition whose id is the file name stem', () => {
    const path = '過去問/探索.problem.yaml';
    const text = textOf(
      createProblemDefinitionText({ id: problemIdFromPath(path), statement: '探索.md', hints: [], solutions: [] })
    );
    expect(parseProblemDefinition(text)).toEqual({
      ok: true,
      value: { id: '探索', statement: '探索.md', hints: [], solutions: [] },
    });
  });

  it('refuses to create a definition with an empty id', () => {
    expect(createProblemDefinitionText({ id: '', statement: 'a.md', hints: [], solutions: [] }).ok).toBe(false);
  });
});

describe('exam definitions', () => {
  const EXAM =
    'format: tc-exam/1\nexamId: midterm-2026 # 中間\nkind: exam\nlanguages: [c]\nproblems:\n  - a.problem.yaml\n';

  it('round-trips a created exam definition', () => {
    const definition = {
      examId: 'm',
      kind: 'class' as const,
      languages: ['c', 'python'],
      problems: ['a.problem.yaml'],
    };
    expect(parseExamDefinition(textOf(createExamDefinitionText(definition)))).toEqual({ ok: true, value: definition });
  });

  it('rejects a kind other than exam or class', () => {
    expect(parseExamDefinition('format: tc-exam/1\nexamId: m\nkind: quiz\nlanguages: [c]\nproblems: []\n')).toEqual({
      ok: false,
      issues: [{ kind: 'invalid-value', key: 'kind', allowed: ['exam', 'class'] }],
    });
  });

  it('rejects a cases file passed as an exam definition', () => {
    const parsed = parseExamDefinition('format: tc-cases/1\ncases: []\n');
    expect(parsed.ok === false && parsed.issues[0]!.kind).toBe('unsupported-format');
  });

  it('keeps comments when problems are reordered', () => {
    const text = textOf(updateExamDefinitionText(EXAM, { problems: ['b.problem.yaml', 'a.problem.yaml'] }));
    const parsed = parseExamDefinition(text);
    expect([text.includes('# 中間'), parsed.ok && parsed.value.problems]).toEqual([
      true,
      ['b.problem.yaml', 'a.problem.yaml'],
    ]);
  });

  it('refuses to drop a required key', () => {
    expect(updateExamDefinitionText(EXAM, { examId: undefined })).toEqual({
      ok: false,
      issues: [{ kind: 'missing-key', key: 'examId' }],
    });
  });
});
