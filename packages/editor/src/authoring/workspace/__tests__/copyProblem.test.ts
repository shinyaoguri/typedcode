import { describe, expect, it } from 'vitest';
import { copyProblem } from '../copyProblem.js';
import { buildExamBundleProblems } from '../examBundle.js';
import { MaterialFolder } from '../materialFolder.js';
import { FakeFileSystem } from './fakeDirectoryHandle.js';
import { memoryReader } from './memoryReader.js';

/** コメントと未知のキーを持つ問題定義 (1 文字も変えずに写ることを見る) */
const MAX_PROBLEM = [
  '# 最大値の問題',
  'format: tc-problem/1',
  'id: 最大値',
  'statement: 最大値.md',
  'starter: 最大値-初期.c',
  'hints: [最大値-ヒント.md]',
  'solutions: [最大値-解答.c]',
  'cases: 最大値.cases.yaml',
  'x-note: 未知のキー',
  '',
].join('\n');

const MAX_CASES = [
  'format: tc-cases/1',
  'cases:',
  '  - name: 正の数',
  '    stdin: "3\\n1 8 4\\n"',
  '    stdout: "8\\n"',
  '    public: true',
  '',
].join('\n');

/** コピー元の教材 (最大値・合計・過去問/探索。合計と探索は本文 `共通.md` を共有する) */
function material(): Record<string, string> {
  return {
    '最大値.problem.yaml': MAX_PROBLEM,
    '最大値.md': '# 最大値\n',
    '最大値-初期.c': 'int main(void) { return 0; }\n',
    '最大値-ヒント.md': 'ヒント\n',
    '最大値-解答.c': 'int main(void) { return 8; }\n',
    '最大値.cases.yaml': MAX_CASES,
    '合計.problem.yaml': 'format: tc-problem/1\nid: 合計\nstatement: 共通.md\n',
    '過去問/探索.problem.yaml':
      'format: tc-problem/1\nid: 探索\nstatement: ../共通.md\nstarter: 探索.py\nsolutions: [../解答/探索.py]\n',
    '共通.md': '# 共通\n',
    '過去問/探索.py': 'print()\n',
    '解答/探索.py': 'print(1)\n',
  };
}

/** コピー先 (fake の FS と、それを包む本物の MaterialFolder) */
function destinationFolder(files: Record<string, string> = {}): { fs: FakeFileSystem; folder: MaterialFolder } {
  const fs = new FakeFileSystem('コピー先', files);
  return { fs, folder: new MaterialFolder(fs.root()) };
}

describe('copyProblem', () => {
  it('writes the definition and every referenced file to the same relative paths with identical contents', async () => {
    const source = material();
    const { fs, folder } = destinationFolder();

    const result = await copyProblem(memoryReader(source), '最大値.problem.yaml', folder);

    const expected = [
      '最大値-ヒント.md',
      '最大値-初期.c',
      '最大値-解答.c',
      '最大値.cases.yaml',
      '最大値.md',
      '最大値.problem.yaml',
    ];
    expect(result.status).toBe('copied');
    expect(await folder.listFiles()).toEqual(expected);
    for (const path of expected) expect(fs.readFile(path)).toBe(source[path]);
  });

  it('lets the destination alone turn the copied problem into an exam bundle problem', async () => {
    const { folder } = destinationFolder({
      '試験.exam.yaml':
        'format: tc-exam/1\nexamId: midterm\nkind: exam\nlanguages: [c]\nproblems:\n  - 最大値.problem.yaml\n',
    });

    await copyProblem(memoryReader(material()), '最大値.problem.yaml', folder);
    const built = await buildExamBundleProblems('試験.exam.yaml', folder);

    expect(built.ok && built.problems).toEqual([
      {
        problemId: '最大値',
        statement: '# 最大値\n',
        starter: { filename: '最大値-初期.c', language: 'c', content: 'int main(void) { return 0; }\n' },
        examples: [{ name: '正の数', stdin: '3\n1 8 4\n', stdout: '8\n' }],
      },
    ]);
  });

  it('keeps the layout of files a subfolder problem reaches through ../ so the references still resolve', async () => {
    const { folder } = destinationFolder({
      '試験.exam.yaml':
        'format: tc-exam/1\nexamId: midterm\nkind: exam\nlanguages: [python]\nproblems:\n  - 過去問/探索.problem.yaml\n',
    });

    const result = await copyProblem(memoryReader(material()), '過去問/探索.problem.yaml', folder);
    const built = await buildExamBundleProblems('試験.exam.yaml', folder);

    expect(result).toEqual({
      status: 'copied',
      written: ['共通.md', '過去問/探索.py', '解答/探索.py', '過去問/探索.problem.yaml'],
    });
    expect(built.ok).toBe(true);
  });

  it('copies a statement file that another problem also references', async () => {
    const { fs, folder } = destinationFolder();

    await copyProblem(memoryReader(material()), '合計.problem.yaml', folder);

    expect(fs.readFile('共通.md')).toBe('# 共通\n');
  });

  it('writes a file referenced twice only once', async () => {
    const source = memoryReader({
      'a.problem.yaml': 'format: tc-problem/1\nid: a\nstatement: a.md\nhints: [a.md]\nsolutions: [./a.md]\n',
      'a.md': '# a\n',
    });
    const { folder } = destinationFolder();

    const result = await copyProblem(source, 'a.problem.yaml', folder);

    expect(result).toEqual({ status: 'copied', written: ['a.md', 'a.problem.yaml'] });
  });

  it('writes nothing and returns the clashing path when one destination file already exists', async () => {
    const { folder } = destinationFolder({ '最大値.md': '# 別の最大値\n' });

    const result = await copyProblem(memoryReader(material()), '最大値.problem.yaml', folder);

    expect(result).toEqual({ status: 'conflict', paths: ['最大値.md'] });
    expect(await folder.listFiles()).toEqual(['最大値.md']);
  });

  it('lists every clashing path, not just the first', async () => {
    const { folder } = destinationFolder({ '最大値.md': 'x', '最大値.problem.yaml': 'y' });

    const result = await copyProblem(memoryReader(material()), '最大値.problem.yaml', folder);

    expect(result).toEqual({ status: 'conflict', paths: ['最大値.md', '最大値.problem.yaml'] });
  });

  it('writes nothing and returns the missing path when a referenced source file is absent', async () => {
    const source = material();
    delete source['最大値-解答.c'];
    const { folder } = destinationFolder();

    const result = await copyProblem(memoryReader(source), '最大値.problem.yaml', folder);

    expect(result).toEqual({
      status: 'source-invalid',
      issues: [{ kind: 'missing-file', problem: '最大値.problem.yaml', path: '最大値-解答.c' }],
    });
    expect(await folder.listFiles()).toEqual([]);
  });

  it('collects every source problem instead of stopping at the first', async () => {
    const source = memoryReader(
      {
        'a.problem.yaml': 'format: tc-problem/1\nid: a\nstatement: ../外.md\nstarter: a.c\nhints: [h.md]\n',
        'h.md': 'h',
      },
      ['h.md']
    );
    const { folder } = destinationFolder();

    const result = await copyProblem(source, 'a.problem.yaml', folder);

    expect(result.status === 'source-invalid' && result.issues.map((i) => i.kind)).toEqual([
      'invalid-reference',
      'missing-file',
      'unreadable-file',
    ]);
    expect(await folder.listFiles()).toEqual([]);
  });

  it('writes nothing when the problem definition cannot be parsed', async () => {
    const source = memoryReader({ 'a.problem.yaml': 'format: tc-problem/1\nid: a\n' });
    const { folder } = destinationFolder();

    const result = await copyProblem(source, 'a.problem.yaml', folder);

    expect(result.status === 'source-invalid' && result.issues.map((i) => i.kind)).toEqual(['invalid-definition']);
    expect(await folder.listFiles()).toEqual([]);
  });

  it('stops at a failed write, reports what was written and leaves the definition unwritten', async () => {
    const { fs, folder } = destinationFolder();
    const denied = new DOMException('permission revoked', 'NotAllowedError');
    fs.failWrites = (path, stage) => (path === '最大値-解答.c' && stage === 'write' ? denied : undefined);

    const result = await copyProblem(memoryReader(material()), '最大値.problem.yaml', folder);

    expect(result).toEqual({
      status: 'failed',
      written: ['最大値.md', '最大値-初期.c', '最大値-ヒント.md'],
      failed: { status: 'failed', path: '最大値-解答.c', cause: denied },
    });
    expect(fs.readFile('最大値.problem.yaml')).toBeUndefined();
  });
});
