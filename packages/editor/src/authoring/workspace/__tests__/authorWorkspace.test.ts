/**
 * AuthorWorkspace (作問画面の状態) のテスト (#796 / ADR-0051)。
 *
 * fake のフォルダ (`fakeDirectoryHandle.ts`) を本物の `MaterialFolder` で包んで回す。保存・競合・読み直しの規則と、
 * 問題の作成・要素の追加・既存のファイルの割り当てが問題定義に正しく書き戻されることを固定する。
 */

import { describe, expect, it } from 'vitest';
import { AuthorWorkspace } from '../authorWorkspace.js';
import { parseCasesDefinition, parseProblemDefinition } from '../definitions.js';
import { MaterialFolder } from '../materialFolder.js';
import { FakeFileSystem } from './fakeDirectoryHandle.js';

const TWO_PROBLEMS: Record<string, string> = {
  '最大値.problem.yaml':
    'format: tc-problem/1\nid: 最大値\ntitle: 数列の最大値\nstatement: 最大値.md\nsolutions: [最大値-解答.c]\n',
  '最大値.md': '# 最大値\n',
  '最大値-解答.c': 'int main(void) { return 0; }\n',
  '過去問/探索.problem.yaml': 'format: tc-problem/1\nid: 探索\nstatement: ../共通.md\nstarter: 探索.py\n',
  '共通.md': '# 探索\n',
  '中間.exam.yaml': 'format: tc-exam/1\nexamId: m\nkind: exam\nlanguages: [c]\nproblems: [最大値.problem.yaml]\n',
};

async function setup(files: Record<string, string> = TWO_PROBLEMS) {
  const fs = new FakeFileSystem('教材', files);
  const folder = new MaterialFolder(fs.root());
  const workspace = new AuthorWorkspace(folder);
  await workspace.refresh();
  return { fs, folder, workspace };
}

function definitionOf(fs: FakeFileSystem, path: string) {
  const parsed = parseProblemDefinition(fs.readFile(path) ?? '');
  if (!parsed.ok) throw new Error(`unreadable definition ${path}: ${JSON.stringify(parsed.issues)}`);
  return parsed.value;
}

describe('AuthorWorkspace index', () => {
  it('lists problem definitions with their parts resolved to root-relative paths', async () => {
    const { workspace } = await setup();
    const problem = workspace.problem('過去問/探索.problem.yaml');
    expect(problem?.status === 'ok' && problem.parts).toEqual([
      { role: 'statement', reference: '../共通.md', path: '共通.md', exists: true },
      { role: 'starter', reference: '探索.py', path: '過去問/探索.py', exists: false },
    ]);
  });

  it('lists exam definitions separately from problems', async () => {
    const { workspace } = await setup();
    expect([workspace.index.exams, workspace.index.problems.map((p) => p.path)]).toEqual([
      ['中間.exam.yaml'],
      ['最大値.problem.yaml', '過去問/探索.problem.yaml'],
    ]);
  });

  it('keeps an unparsable problem definition in the index with its issues', async () => {
    const { workspace } = await setup({ ...TWO_PROBLEMS, '壊れた.problem.yaml': 'format: tc-problem/99\n' });
    expect(workspace.problem('壊れた.problem.yaml')).toEqual({
      status: 'invalid',
      path: '壊れた.problem.yaml',
      issues: [{ kind: 'unsupported-format', found: 'tc-problem/99', expected: 'tc-problem/1' }],
    });
  });

  it('marks a reference that climbs out of the folder as unresolvable', async () => {
    const { workspace } = await setup({ 'a.problem.yaml': 'format: tc-problem/1\nid: a\nstatement: ../外.md\n' });
    const problem = workspace.problem('a.problem.yaml');
    expect(problem?.status === 'ok' && problem.parts[0]).toEqual({
      role: 'statement',
      reference: '../外.md',
      path: null,
      exists: false,
      rejection: 'outside-root',
    });
  });

  it('refresh picks up files added outside the editor', async () => {
    const { fs, workspace } = await setup();
    fs.writeExternally('過去問/探索.py', 'print()\n');
    await workspace.refresh();
    const problem = workspace.problem('過去問/探索.problem.yaml');
    expect(problem?.status === 'ok' && problem.parts[1]?.exists).toBe(true);
  });
});

describe('AuthorWorkspace NFC matching', () => {
  // macOS / 同期フォルダは「が」を「か + 濁点」(NFD) で返すことがある
  const nfdStem = 'がっこう'.normalize('NFD');
  const nfcStem = 'がっこう'.normalize('NFC');

  it('matches an NFC reference against an NFD file name and keeps the listed spelling for I/O', async () => {
    const { workspace } = await setup({
      [`${nfdStem}.problem.yaml`]: `format: tc-problem/1\nid: x\nstatement: ${nfcStem}.md\n`,
      [`${nfdStem}.md`]: '# x\n',
    });
    const problem = workspace.problem(`${nfcStem}.problem.yaml`);
    expect(problem?.status === 'ok' && problem.parts[0]).toEqual({
      role: 'statement',
      reference: `${nfcStem}.md`,
      path: `${nfdStem}.md`,
      exists: true,
    });
  });

  it('opens an NFD file by its NFC name', async () => {
    const { workspace } = await setup({ [`${nfdStem}.md`]: '# x\n' });
    const opened = await workspace.open(`${nfcStem}.md`);
    expect(opened.ok && opened.document.path).toBe(`${nfdStem}.md`);
  });
});

describe('AuthorWorkspace documents', () => {
  it('editing a document marks it dirty and counts it', async () => {
    const { workspace } = await setup();
    await workspace.open('最大値.md');
    workspace.setText('最大値.md', '# 最大値\n\n本文\n');
    expect([workspace.document('最大値.md')?.dirty, workspace.dirtyCount()]).toEqual([true, 1]);
  });

  it('saving writes the file and clears the dirty mark', async () => {
    const { fs, workspace } = await setup();
    await workspace.open('最大値.md');
    workspace.setText('最大値.md', '# 最大値\n\n本文\n');
    const result = await workspace.save('最大値.md');
    expect([result.status, fs.readFile('最大値.md'), workspace.dirtyCount()]).toEqual([
      'saved',
      '# 最大値\n\n本文\n',
      0,
    ]);
  });

  it('a conflicting save writes nothing and keeps the local edit unsaved', async () => {
    const { fs, workspace } = await setup();
    await workspace.open('最大値.md');
    workspace.setText('最大値.md', 'mine');
    fs.writeExternally('最大値.md', 'theirs');
    const result = await workspace.save('最大値.md');
    expect([result.status, fs.readFile('最大値.md'), workspace.document('最大値.md')]).toEqual([
      'conflict',
      'theirs',
      { path: '最大値.md', savedText: '# 最大値\n', text: 'mine', dirty: true },
    ]);
  });

  it('overwrite writes the local edit despite the external change', async () => {
    const { fs, workspace } = await setup();
    await workspace.open('最大値.md');
    workspace.setText('最大値.md', 'mine');
    fs.writeExternally('最大値.md', 'theirs');
    await workspace.save('最大値.md');
    const result = await workspace.save('最大値.md', { overwrite: true });
    expect([result.status, fs.readFile('最大値.md'), workspace.dirtyCount()]).toEqual(['saved', 'mine', 0]);
  });

  it('reload replaces the local edit with the content on disk', async () => {
    const { fs, workspace } = await setup();
    await workspace.open('最大値.md');
    workspace.setText('最大値.md', 'mine');
    fs.writeExternally('最大値.md', 'theirs');
    await workspace.reload('最大値.md');
    expect(workspace.document('最大値.md')).toEqual({
      path: '最大値.md',
      savedText: 'theirs',
      text: 'theirs',
      dirty: false,
    });
  });

  it('after reloading, saving no longer conflicts with the external change', async () => {
    const { fs, workspace } = await setup();
    await workspace.open('最大値.md');
    fs.writeExternally('最大値.md', 'theirs');
    await workspace.reload('最大値.md');
    workspace.setText('最大値.md', 'theirs + mine');
    expect((await workspace.save('最大値.md')).status).toBe('saved');
  });

  it('a failed save leaves the document dirty', async () => {
    const { fs, workspace } = await setup();
    await workspace.open('最大値.md');
    workspace.setText('最大値.md', 'mine');
    fs.failWrites = () => new Error('disk is gone');
    const result = await workspace.save('最大値.md');
    expect([result.status, workspace.document('最大値.md')?.dirty]).toEqual(['failed', true]);
  });

  it('refreshing the index does not hide an external change to an open document', async () => {
    const { fs, workspace } = await setup();
    await workspace.open('最大値.problem.yaml');
    workspace.setText('最大値.problem.yaml', `${fs.readFile('最大値.problem.yaml')}# mine\n`);
    fs.writeExternally('最大値.problem.yaml', 'format: tc-problem/1\nid: 最大値\nstatement: 最大値.md\n');
    await workspace.refresh();
    expect((await workspace.save('最大値.problem.yaml')).status).toBe('conflict');
  });

  it('saveAll reports a result for each dirty document and saves the ones without conflicts', async () => {
    const { fs, workspace } = await setup();
    await workspace.open('最大値.md');
    await workspace.open('共通.md');
    workspace.setText('最大値.md', 'a');
    workspace.setText('共通.md', 'b');
    fs.writeExternally('最大値.md', 'theirs');
    const results = await workspace.saveAll();
    expect([results.map((r) => [r.path, r.status]), fs.readFile('共通.md')]).toEqual([
      [
        ['最大値.md', 'conflict'],
        ['共通.md', 'saved'],
      ],
      'b',
    ]);
  });

  it('closing a document discards it', async () => {
    const { workspace } = await setup();
    await workspace.open('最大値.md');
    workspace.setText('最大値.md', 'mine');
    workspace.close('最大値.md');
    expect([workspace.document('最大値.md'), workspace.dirtyCount()]).toEqual([undefined, 0]);
  });

  it('opening a missing file fails without creating a document', async () => {
    const { workspace } = await setup();
    const opened = await workspace.open('無い.md');
    expect([opened.ok, workspace.documents()]).toEqual([false, []]);
  });
});

describe('AuthorWorkspace problem operations', () => {
  it('creating a problem writes a statement and a definition that points to it', async () => {
    const { fs, workspace } = await setup({});
    const result = await workspace.createProblem('合計');
    expect([result, fs.readFile('合計.md'), definitionOf(fs, '合計.problem.yaml')]).toEqual([
      { ok: true, path: '合計.problem.yaml' },
      '# 合計\n',
      { id: '合計', statement: '合計.md', hints: [], solutions: [] },
    ]);
  });

  it('creates a problem inside a subfolder with the id taken from the file name', async () => {
    const { fs, workspace } = await setup({});
    await workspace.createProblem('過去問/二分探索');
    expect([fs.readFile('過去問/二分探索.md'), definitionOf(fs, '過去問/二分探索.problem.yaml')]).toEqual([
      '# 二分探索\n',
      { id: '二分探索', statement: '二分探索.md', hints: [], solutions: [] },
    ]);
  });

  it('does not create anything when a file of the same name exists', async () => {
    const { fs, workspace } = await setup({ '合計.problem.yaml': 'existing' });
    const result = await workspace.createProblem('合計');
    expect([result, fs.readFile('合計.problem.yaml'), fs.readFile('合計.md')]).toEqual([
      { ok: false, error: { kind: 'exists', path: '合計.problem.yaml' } },
      'existing',
      undefined,
    ]);
  });

  it('rejects a problem name that would be hidden or leave the folder', async () => {
    const { workspace } = await setup({});
    const results = await Promise.all(['', '../外', '.隠し', 'a//b'].map((name) => workspace.createProblem(name)));
    expect(results.map((r) => !r.ok && r.error.kind)).toEqual([
      'invalid-name',
      'invalid-name',
      'invalid-name',
      'invalid-name',
    ]);
  });

  it('a problem built from its statement keeps one starter, two hints and two solutions after reloading', async () => {
    const { fs, workspace } = await setup({});
    await workspace.createProblem('合計');
    const steps: Array<[Parameters<AuthorWorkspace['addPart']>[1], string]> = [
      ['starter', '合計-初期.c'],
      ['hint', '合計-ヒント.md'],
      ['hint', '合計-ヒント2.md'],
      ['solution', '合計-解答.c'],
      ['solution', '合計-解答2.c'],
    ];
    for (const [role, name] of steps) {
      const result = await workspace.addPart('合計.problem.yaml', role, name);
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      await workspace.open(result.path);
      workspace.setText(result.path, `content of ${name}\n`);
      await workspace.save(result.path);
    }

    const reopened = new AuthorWorkspace(new MaterialFolder(fs.root()));
    await reopened.refresh();
    const problem = reopened.problem('合計.problem.yaml');
    const parts = problem?.status === 'ok' ? problem.parts : [];
    const contents = await Promise.all(
      parts.map(async (part) => {
        const opened = await reopened.open(part.path ?? '');
        return [part.role, part.path, opened.ok ? opened.document.text : null];
      })
    );
    expect(contents).toEqual([
      ['statement', '合計.md', '# 合計\n'],
      ['starter', '合計-初期.c', 'content of 合計-初期.c\n'],
      ['hint', '合計-ヒント.md', 'content of 合計-ヒント.md\n'],
      ['hint', '合計-ヒント2.md', 'content of 合計-ヒント2.md\n'],
      ['solution', '合計-解答.c', 'content of 合計-解答.c\n'],
      ['solution', '合計-解答2.c', 'content of 合計-解答2.c\n'],
    ]);
  });

  it('adding cases creates an empty cases file the definition refers to', async () => {
    const { fs, workspace } = await setup();
    await workspace.addPart('最大値.problem.yaml', 'cases', '最大値.cases.yaml');
    expect([
      parseCasesDefinition(fs.readFile('最大値.cases.yaml') ?? ''),
      definitionOf(fs, '最大値.problem.yaml').cases,
    ]).toEqual([{ ok: true, value: [] }, '最大値.cases.yaml']);
  });

  it('adding a part keeps the comments and unknown keys of the definition', async () => {
    const { fs, workspace } = await setup({
      'a.problem.yaml': 'format: tc-problem/1\n# 教員メモ\nid: a\nstatement: a.md\nnote: keep\n',
      'a.md': '# a\n',
    });
    await workspace.addPart('a.problem.yaml', 'hint', 'a-ヒント.md');
    expect(fs.readFile('a.problem.yaml')).toBe(
      'format: tc-problem/1\n# 教員メモ\nid: a\nstatement: a.md\nnote: keep\nhints: [a-ヒント.md]\n'
    );
  });

  it('refuses a second starter without creating its file', async () => {
    const { fs, workspace } = await setup();
    const result = await workspace.addPart('過去問/探索.problem.yaml', 'starter', '別.py');
    expect([result, fs.readFile('過去問/別.py')]).toEqual([
      { ok: false, error: { kind: 'already-assigned', role: 'starter', path: '過去問/探索.problem.yaml' } },
      undefined,
    ]);
  });

  it('refuses to add a part over an existing file', async () => {
    const { fs, workspace } = await setup();
    const result = await workspace.addPart('最大値.problem.yaml', 'solution', '最大値.md');
    expect([result, fs.readFile('最大値.md')]).toEqual([
      { ok: false, error: { kind: 'exists', path: '最大値.md' } },
      '# 最大値\n',
    ]);
  });

  it('assigning an existing file as a solution writes its path into solutions', async () => {
    const { fs, workspace } = await setup({ ...TWO_PROBLEMS, '最大値-別解.c': 'x' });
    const result = await workspace.assignPart('最大値.problem.yaml', 'solution', '最大値-別解.c');
    expect([result, definitionOf(fs, '最大値.problem.yaml').solutions]).toEqual([
      { ok: true, path: '最大値-別解.c' },
      ['最大値-解答.c', '最大値-別解.c'],
    ]);
  });

  it('assigning a file above a definition in a subfolder writes a .. reference', async () => {
    const { fs, workspace } = await setup();
    await workspace.assignPart('過去問/探索.problem.yaml', 'solution', '最大値-解答.c');
    const definition = definitionOf(fs, '過去問/探索.problem.yaml');
    const problem = workspace.problem('過去問/探索.problem.yaml');
    expect([definition.solutions, problem?.status === 'ok' && problem.parts.at(-1)]).toEqual([
      ['../最大値-解答.c'],
      { role: 'solution', reference: '../最大値-解答.c', path: '最大値-解答.c', exists: true },
    ]);
  });

  it('refuses to assign the same solution twice', async () => {
    const { workspace } = await setup();
    const result = await workspace.assignPart('最大値.problem.yaml', 'solution', '最大値-解答.c');
    expect(result).toEqual({
      ok: false,
      error: { kind: 'already-assigned', role: 'solution', path: '最大値-解答.c' },
    });
  });

  it('refuses to assign a file that is not in the folder', async () => {
    const { workspace } = await setup();
    const result = await workspace.assignPart('最大値.problem.yaml', 'hint', '無い.md');
    expect(result).toEqual({ ok: false, error: { kind: 'missing-file', path: '無い.md' } });
  });

  it('stops changing a definition that has unsaved edits and writes nothing', async () => {
    const { fs, workspace } = await setup();
    const before = fs.readFile('最大値.problem.yaml');
    await workspace.open('最大値.problem.yaml');
    workspace.setText('最大値.problem.yaml', `${before}# editing\n`);
    const result = await workspace.addPart('最大値.problem.yaml', 'hint', '最大値-ヒント.md');
    expect([result, fs.readFile('最大値.problem.yaml'), fs.readFile('最大値-ヒント.md')]).toEqual([
      { ok: false, error: { kind: 'definition-dirty', path: '最大値.problem.yaml' } },
      before,
      undefined,
    ]);
  });

  it('updates an open, unedited definition document to the written definition', async () => {
    const { fs, workspace } = await setup();
    await workspace.open('最大値.problem.yaml');
    await workspace.addPart('最大値.problem.yaml', 'hint', '最大値-ヒント.md');
    expect(workspace.document('最大値.problem.yaml')).toEqual({
      path: '最大値.problem.yaml',
      savedText: fs.readFile('最大値.problem.yaml'),
      text: fs.readFile('最大値.problem.yaml'),
      dirty: false,
    });
  });

  it('refuses to change a definition that cannot be parsed', async () => {
    const { workspace } = await setup({ 'x.problem.yaml': 'format: tc-problem/1\nid: x\n' });
    const result = await workspace.addPart('x.problem.yaml', 'hint', 'x-ヒント.md');
    expect(!result.ok && result.error.kind).toBe('definition-invalid');
  });
});

describe('AuthorWorkspace bundle', () => {
  it('builds the bundle problems from every problem definition in path order', async () => {
    const { workspace } = await setup({
      'b.problem.yaml': 'format: tc-problem/1\nid: b\nstatement: b.md\n',
      'b.md': '# b\n',
      'a.problem.yaml': 'format: tc-problem/1\nid: a\nstatement: a.md\nstarter: a.c\n',
      'a.md': '# a\n',
      'a.c': 'int x;\n',
    });
    expect(await workspace.buildBundle()).toEqual({
      status: 'ok',
      problems: [
        { problemId: 'a', statement: '# a\n', starter: { filename: 'a.c', language: 'c', content: 'int x;\n' } },
        { problemId: 'b', statement: '# b\n' },
      ],
    });
  });

  it('refuses to build while a document has unsaved edits', async () => {
    const { workspace } = await setup();
    await workspace.open('最大値.md');
    workspace.setText('最大値.md', 'mine');
    expect(await workspace.buildBundle()).toEqual({ status: 'dirty', paths: ['最大値.md'] });
  });

  it('reports missing parts instead of building', async () => {
    const { workspace } = await setup();
    const result = await workspace.buildBundle();
    expect(result.status === 'invalid' && result.issues).toEqual([
      { kind: 'missing-file', problem: '過去問/探索.problem.yaml', path: '過去問/探索.py' },
    ]);
  });

  it('reports an empty folder as having no problems', async () => {
    const { workspace } = await setup({});
    expect(await workspace.buildBundle()).toEqual({ status: 'empty' });
  });

  it('readCurrentText returns the unsaved text of an open document (#799)', async () => {
    const { workspace } = await setup();
    await workspace.open('最大値-解答.c');
    workspace.setText('最大値-解答.c', 'mine');
    expect(await workspace.readCurrentText('最大値-解答.c')).toBe('mine');
  });

  it('readCurrentText of an open document does not re-read the file, so a later save still detects the external change (#799)', async () => {
    const { fs, workspace } = await setup();
    await workspace.open('最大値-解答.c');
    workspace.setText('最大値-解答.c', 'mine');
    fs.writeExternally('最大値-解答.c', 'theirs');
    await workspace.readCurrentText('最大値-解答.c');
    expect((await workspace.save('最大値-解答.c')).status).toBe('conflict');
  });

  it('readCurrentText reads a file that is not open from the folder (#799)', async () => {
    const { fs, workspace } = await setup();
    fs.writeExternally('最大値-解答.c', 'on disk');
    expect(await workspace.readCurrentText('最大値-解答.c')).toBe('on disk');
  });

  it('reads NFD-listed files through NFC references when building', async () => {
    const nfd = 'がっこう'.normalize('NFD');
    const { workspace } = await setup({
      [`${nfd}.problem.yaml`]: `format: tc-problem/1\nid: x\nstatement: ${'がっこう'.normalize('NFC')}.md\n`,
      [`${nfd}.md`]: '# x\n',
    });
    expect(await workspace.buildBundle()).toEqual({ status: 'ok', problems: [{ problemId: 'x', statement: '# x\n' }] });
  });
});
