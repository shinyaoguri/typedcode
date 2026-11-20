import { describe, expect, it } from 'vitest';
import type { ProblemPart } from '../../workspace/authorWorkspace.js';
import { dottedExtension, isMarkdownPath, monacoLanguageFor, runLanguageFor } from '../fileKinds.js';
import { defaultPartName } from '../partNames.js';

const WORDS = { starter: '初期', hint: 'ヒント', solution: '解答' };

function part(role: ProblemPart['role'], path: string): ProblemPart {
  return { role, reference: path, path, exists: true };
}

describe('defaultPartName', () => {
  it('names the first part of a role with the stem and the role word', () => {
    const name = defaultPartName({
      problemPath: '最大値.problem.yaml',
      role: 'hint',
      words: WORDS,
      parts: [],
      files: [],
    });
    expect(name).toBe('最大値-ヒント.md');
  });

  it('numbers the second part of the same role', () => {
    const name = defaultPartName({
      problemPath: '最大値.problem.yaml',
      role: 'solution',
      words: WORDS,
      parts: [part('solution', '最大値-解答.c')],
      files: ['最大値-解答.c'],
    });
    expect(name).toBe('最大値-解答2.c');
  });

  it('follows the extension of the existing starter for code parts', () => {
    const name = defaultPartName({
      problemPath: '過去問/探索.problem.yaml',
      role: 'solution',
      words: WORDS,
      parts: [part('starter', '過去問/探索.py')],
      files: [],
    });
    expect(name).toBe('探索-解答.py');
  });

  it('uses .c for code parts when the problem has no code yet', () => {
    const name = defaultPartName({
      problemPath: 'a.problem.yaml',
      role: 'starter',
      words: WORDS,
      parts: [],
      files: [],
    });
    expect(name).toBe('a-初期.c');
  });

  it('skips a name that is already taken in the folder of the definition', () => {
    const name = defaultPartName({
      problemPath: 'sub/a.problem.yaml',
      role: 'hint',
      words: WORDS,
      parts: [],
      files: ['sub/a-ヒント.md'],
    });
    expect(name).toBe('a-ヒント2.md');
  });

  it('names cases after the stem with the cases suffix', () => {
    const name = defaultPartName({ problemPath: 'a.problem.yaml', role: 'cases', words: WORDS, parts: [], files: [] });
    expect(name).toBe('a.cases.yaml');
  });
});

describe('fileKinds', () => {
  it('maps extensions to Monaco languages including Markdown and YAML', () => {
    expect(['a.md', 'a.yaml', 'a.yml', 'a.c', 'a.cpp', 'a.py', 'a.js', 'a.ts', 'a.txt'].map(monacoLanguageFor)).toEqual(
      ['markdown', 'yaml', 'yaml', 'c', 'cpp', 'python', 'javascript', 'typescript', 'plaintext']
    );
  });

  it('runs a file in the language the bundle would declare', () => {
    expect([runLanguageFor('dir/p1.ts'), runLanguageFor('p1.md')]).toEqual(['typescript', 'plaintext']);
  });

  it('recognizes Markdown and keeps the spelling of an extension', () => {
    expect([isMarkdownPath('x/A.MD'), dottedExtension('x/a.Py'), dottedExtension('Makefile')]).toEqual([
      true,
      '.Py',
      '',
    ]);
  });
});
