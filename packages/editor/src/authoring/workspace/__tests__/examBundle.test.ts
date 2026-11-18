import { describe, expect, it } from 'vitest';
import { buildBundleProblemsFromPaths, buildExamBundleProblems } from '../examBundle.js';
import { memoryReader } from './memoryReader.js';

/** 3 問を持つ教材 (最大値・合計・過去問/探索)。 */
function material(): Record<string, string> {
  return {
    '最大値.problem.yaml': [
      'format: tc-problem/1',
      'id: 最大値',
      'title: 数列の最大値',
      'statement: 最大値.md',
      'starter: 最大値-初期.c',
      'hints: [最大値-ヒント.md]',
      'solutions: [最大値-解答.c, 最大値-別解.c]',
      'cases: 最大値.cases.yaml',
      '',
    ].join('\n'),
    '最大値.md': '# 最大値\n',
    '最大値-初期.c': 'int main(void) { return 0; }\n',
    '最大値-ヒント.md': 'HINT-SECRET',
    '最大値-解答.c': 'SOLUTION-SECRET-1',
    '最大値-別解.c': 'SOLUTION-SECRET-2',
    '最大値.cases.yaml': [
      'format: tc-cases/1',
      'cases:',
      '  - name: 正の数',
      '    stdin: "3\\n1 8 4\\n"',
      '    stdout: "8\\n"',
      '    public: true',
      '    match: exact',
      '  - name: 非公開',
      '    stdin: "HIDDEN-STDIN"',
      '    stdout: "HIDDEN-STDOUT"',
      '',
    ].join('\n'),
    '合計.problem.yaml': 'format: tc-problem/1\nid: 合計\nstatement: 合計.md\n',
    '合計.md': '# 合計\n',
    '過去問/探索.problem.yaml':
      'format: tc-problem/1\nid: 探索\nstatement: ../共通.md\nstarter: 探索.py\nsolutions: [探索-解答.py]\n',
    '共通.md': '# 探索\n',
    '過去問/探索.py': 'print()\n',
    '過去問/探索-解答.py': 'SOLUTION-SECRET-3',
    '中間試験.exam.yaml':
      'format: tc-exam/1\nexamId: midterm\nkind: exam\nlanguages: [c, python]\nproblems:\n  - 過去問/探索.problem.yaml\n  - 最大値.problem.yaml\n',
  };
}

describe('buildExamBundleProblems', () => {
  it('returns the adopted problems in the order the exam lists them', async () => {
    const result = await buildExamBundleProblems('中間試験.exam.yaml', memoryReader(material()));
    expect(result.ok && result.problems.map((p) => p.problemId)).toEqual(['探索', '最大値']);
  });

  it('maps statement, starter and public cases as the spec table says', async () => {
    const result = await buildExamBundleProblems('中間試験.exam.yaml', memoryReader(material()));
    expect(result.ok && result.problems).toEqual([
      {
        problemId: '探索',
        statement: '# 探索\n',
        starter: { filename: '探索.py', language: 'python', content: 'print()\n' },
      },
      {
        problemId: '最大値',
        statement: '# 最大値\n',
        starter: { filename: '最大値-初期.c', language: 'c', content: 'int main(void) { return 0; }\n' },
        examples: [{ name: '正の数', stdin: '3\n1 8 4\n', stdout: '8\n' }],
      },
    ]);
  });

  it('leaves solutions, hints, private cases and the title out of the bundle', async () => {
    const result = await buildExamBundleProblems('中間試験.exam.yaml', memoryReader(material()));
    const serialized = JSON.stringify(result);
    const leaked = ['SECRET', 'HIDDEN', '数列の最大値', '非公開'].filter((s) => serialized.includes(s));
    expect(leaked).toEqual([]);
  });

  it('reports the problem and path of a missing starter and returns no problems', async () => {
    const files = material();
    delete files['最大値-初期.c'];
    const result = await buildExamBundleProblems('中間試験.exam.yaml', memoryReader(files));
    expect(result).toEqual({
      ok: false,
      issues: [{ kind: 'missing-file', problem: '最大値.problem.yaml', path: '最大値-初期.c' }],
    });
  });

  it('counts a missing solution file as missing even though solutions are never distributed', async () => {
    const files = material();
    delete files['最大値-別解.c'];
    const result = await buildExamBundleProblems('中間試験.exam.yaml', memoryReader(files));
    expect(result).toEqual({
      ok: false,
      issues: [{ kind: 'missing-file', problem: '最大値.problem.yaml', path: '最大値-別解.c' }],
    });
  });

  it('collects every missing file across problems instead of stopping at the first', async () => {
    const files = material();
    delete files['最大値-ヒント.md'];
    delete files['共通.md'];
    const result = await buildExamBundleProblems('中間試験.exam.yaml', memoryReader(files));
    expect(result.ok ? [] : result.issues).toEqual([
      { kind: 'missing-file', problem: '過去問/探索.problem.yaml', path: '共通.md' },
      { kind: 'missing-file', problem: '最大値.problem.yaml', path: '最大値-ヒント.md' },
    ]);
  });

  it('rejects a problem whose reference climbs out of the folder', async () => {
    const files = material();
    files['合計.problem.yaml'] = 'format: tc-problem/1\nid: 合計\nstatement: ../外.md\n';
    files['中間試験.exam.yaml'] =
      'format: tc-exam/1\nexamId: m\nkind: exam\nlanguages: [c]\nproblems: [合計.problem.yaml]\n';
    const result = await buildExamBundleProblems('中間試験.exam.yaml', memoryReader(files));
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          kind: 'invalid-reference',
          problem: '合計.problem.yaml',
          source: '合計.problem.yaml',
          reference: '../外.md',
          reason: 'outside-root',
        },
      ],
    });
  });

  it('rejects an exam whose problem reference is absolute', async () => {
    const files = material();
    files['中間試験.exam.yaml'] =
      'format: tc-exam/1\nexamId: m\nkind: exam\nlanguages: [c]\nproblems: [/abs.problem.yaml]\n';
    const result = await buildExamBundleProblems('中間試験.exam.yaml', memoryReader(files));
    expect(result.ok === false && result.issues[0]).toMatchObject({ kind: 'invalid-reference', reason: 'absolute' });
  });

  it('reports a problem definition that cannot be parsed together with its path', async () => {
    const files = material();
    files['最大値.problem.yaml'] = 'format: tc-problem/99\n';
    const result = await buildExamBundleProblems('中間試験.exam.yaml', memoryReader(files));
    expect(result.ok === false && result.issues).toEqual([
      {
        kind: 'invalid-definition',
        problem: '最大値.problem.yaml',
        path: '最大値.problem.yaml',
        issues: [{ kind: 'unsupported-format', found: 'tc-problem/99', expected: 'tc-problem/1' }],
      },
    ]);
  });

  it('reports a file that exists but cannot be read', async () => {
    const files = material();
    delete files['合計.md'];
    files['中間試験.exam.yaml'] =
      'format: tc-exam/1\nexamId: m\nkind: exam\nlanguages: [c]\nproblems: [合計.problem.yaml]\n';
    const result = await buildExamBundleProblems('中間試験.exam.yaml', memoryReader(files, ['合計.md']));
    expect(result.ok === false && result.issues[0]).toMatchObject({ kind: 'unreadable-file', path: '合計.md' });
  });

  it('reports a missing exam definition with no problem attached', async () => {
    const result = await buildExamBundleProblems('無い.exam.yaml', memoryReader({}));
    expect(result).toEqual({ ok: false, issues: [{ kind: 'missing-file', problem: null, path: '無い.exam.yaml' }] });
  });

  it('rejects two adopted problems that share an id', async () => {
    const files = material();
    files['合計.problem.yaml'] = 'format: tc-problem/1\nid: 最大値\nstatement: 合計.md\n';
    files['中間試験.exam.yaml'] =
      'format: tc-exam/1\nexamId: m\nkind: exam\nlanguages: [c]\nproblems: [最大値.problem.yaml, 合計.problem.yaml]\n';
    const result = await buildExamBundleProblems('中間試験.exam.yaml', memoryReader(files));
    expect(result).toEqual({
      ok: false,
      issues: [{ kind: 'duplicate-problem-id', id: '最大値', problems: ['最大値.problem.yaml', '合計.problem.yaml'] }],
    });
  });

  it('rejects two adopted problems whose starters share a distributed file name', async () => {
    const files = material();
    files['合計.problem.yaml'] = 'format: tc-problem/1\nid: 合計\nstatement: 合計.md\nstarter: 過去問/探索.py\n';
    files['中間試験.exam.yaml'] =
      'format: tc-exam/1\nexamId: m\nkind: exam\nlanguages: [python]\nproblems: [過去問/探索.problem.yaml, 合計.problem.yaml]\n';
    const result = await buildExamBundleProblems('中間試験.exam.yaml', memoryReader(files));
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          kind: 'duplicate-filename',
          filename: '探索.py',
          problems: ['過去問/探索.problem.yaml', '合計.problem.yaml'],
        },
      ],
    });
  });

  it('returns the exam definition alongside the problems', async () => {
    const result = await buildExamBundleProblems('中間試験.exam.yaml', memoryReader(material()));
    expect(result.ok && result.exam).toEqual({
      examId: 'midterm',
      kind: 'exam',
      languages: ['c', 'python'],
      problems: ['過去問/探索.problem.yaml', '最大値.problem.yaml'],
    });
  });
});

describe('buildBundleProblemsFromPaths', () => {
  it('converts the given problem definitions in the given order', async () => {
    const result = await buildBundleProblemsFromPaths(
      ['合計.problem.yaml', '過去問/探索.problem.yaml'],
      memoryReader(material())
    );
    expect(result).toEqual({
      ok: true,
      problems: [
        { problemId: '合計', statement: '# 合計\n' },
        {
          problemId: '探索',
          statement: '# 探索\n',
          starter: { filename: '探索.py', language: 'python', content: 'print()\n' },
        },
      ],
    });
  });

  it('reports missing files of every given problem and returns no problems', async () => {
    const files = material();
    delete files['合計.md'];
    delete files['過去問/探索-解答.py'];
    const result = await buildBundleProblemsFromPaths(
      ['合計.problem.yaml', '過去問/探索.problem.yaml'],
      memoryReader(files)
    );
    expect(result).toEqual({
      ok: false,
      issues: [
        { kind: 'missing-file', problem: '合計.problem.yaml', path: '合計.md' },
        { kind: 'missing-file', problem: '過去問/探索.problem.yaml', path: '過去問/探索-解答.py' },
      ],
    });
  });

  it('rejects two given problems that share an id', async () => {
    const files = material();
    files['合計.problem.yaml'] = 'format: tc-problem/1\nid: 探索\nstatement: 合計.md\n';
    const result = await buildBundleProblemsFromPaths(
      ['合計.problem.yaml', '過去問/探索.problem.yaml'],
      memoryReader(files)
    );
    expect(result).toEqual({
      ok: false,
      issues: [
        { kind: 'duplicate-problem-id', id: '探索', problems: ['合計.problem.yaml', '過去問/探索.problem.yaml'] },
      ],
    });
  });
});
