/**
 * 検証の対象の収集 (#799)。索引の問題は本物の `AuthorWorkspace` (fake のフォルダ) で作り、内容は
 * `AuthorWorkspace.readCurrentText` (開いている文書は今のテキスト) から読む。
 */

import { describe, expect, it } from 'vitest';
import { AuthorWorkspace } from '../../workspace/authorWorkspace.js';
import { MaterialFolder } from '../../workspace/materialFolder.js';
import { FakeFileSystem } from '../../workspace/__tests__/fakeDirectoryHandle.js';
import { collectVerificationTargets, type VerificationSource } from '../collectTargets.js';

const CASES = [
  'format: tc-cases/1',
  'cases:',
  '  - name: 正の数',
  '    stdin: "3\\n1 8 4\\n"',
  '    stdout: "8\\n"',
  '  - name: 負の数だけ',
  '    stdin: "3\\n-5 -2 -8\\n"',
  '    stdout: "-2\\n"',
  '    match: exact',
  '',
].join('\n');

const FILES: Record<string, string> = {
  'max.problem.yaml':
    'format: tc-problem/1\nid: max\nstatement: max.md\nsolutions: [解答/max-first.c, 解答/max.py]\ncases: max.cases.yaml\n',
  'max.md': '# 最大値\n',
  '解答/max-first.c': 'int main(void){return 0;}\n',
  '解答/max.py': 'print(max(map(int, input().split())))\n',
  'max.cases.yaml': CASES,
};

async function setup(files: Record<string, string> = FILES) {
  const fs = new FakeFileSystem('教材', files);
  const workspace = new AuthorWorkspace(new MaterialFolder(fs.root()));
  await workspace.refresh();
  const source: VerificationSource = { readText: (path) => workspace.readCurrentText(path) };
  return { fs, workspace, source };
}

function problemOf(workspace: AuthorWorkspace, path = 'max.problem.yaml') {
  const problem = workspace.problem(path);
  if (!problem) throw new Error(`no problem ${path}`);
  return problem;
}

describe('collectVerificationTargets', () => {
  it('collects solutions in definition order with their language from the extension, and cases with their match', async () => {
    const { workspace, source } = await setup();
    const targets = await collectVerificationTargets(problemOf(workspace), source);
    expect(targets).toEqual({
      ok: true,
      problemPath: 'max.problem.yaml',
      solutions: [
        { name: '解答/max-first.c', language: 'c', filename: 'max-first.c', code: FILES['解答/max-first.c'] },
        { name: '解答/max.py', language: 'python', filename: 'max.py', code: FILES['解答/max.py'] },
      ],
      cases: [
        { name: '正の数', stdin: '3\n1 8 4\n', stdout: '8\n', match: 'trim' },
        { name: '負の数だけ', stdin: '3\n-5 -2 -8\n', stdout: '-2\n', match: 'exact' },
      ],
    });
  });

  it('uses the unsaved text of an open solution document', async () => {
    const { workspace, source } = await setup();
    await workspace.open('解答/max-first.c');
    workspace.setText('解答/max-first.c', 'unsaved');
    const targets = await collectVerificationTargets(problemOf(workspace), source);
    expect(targets.ok && targets.solutions[0]?.code).toBe('unsaved');
  });

  it('uses the unsaved text of an open cases document', async () => {
    const { workspace, source } = await setup();
    await workspace.open('max.cases.yaml');
    workspace.setText(
      'max.cases.yaml',
      'format: tc-cases/1\ncases:\n  - name: 編集中\n    stdin: ""\n    stdout: "x"\n'
    );
    const targets = await collectVerificationTargets(problemOf(workspace), source);
    expect(targets.ok && targets.cases.map((c) => c.name)).toEqual(['編集中']);
  });

  it('keeps an unknown extension as its language so the runner reports it unsupported', async () => {
    const { workspace, source } = await setup({
      ...FILES,
      'max.problem.yaml':
        'format: tc-problem/1\nid: max\nstatement: max.md\nsolutions: [max.rb]\ncases: max.cases.yaml\n',
      'max.rb': 'puts 1\n',
    });
    const targets = await collectVerificationTargets(problemOf(workspace), source);
    expect(targets.ok && targets.solutions.map((s) => s.language)).toEqual(['plaintext']);
  });

  it('does not run a problem without solutions', async () => {
    const { workspace, source } = await setup({
      ...FILES,
      'max.problem.yaml': 'format: tc-problem/1\nid: max\nstatement: max.md\ncases: max.cases.yaml\n',
    });
    const targets = await collectVerificationTargets(problemOf(workspace), source);
    expect(targets).toEqual({ ok: false, problemPath: 'max.problem.yaml', reason: { kind: 'no-solutions' } });
  });

  it('does not run a problem without a cases file', async () => {
    const { workspace, source } = await setup({
      ...FILES,
      'max.problem.yaml': 'format: tc-problem/1\nid: max\nstatement: max.md\nsolutions: [解答/max-first.c]\n',
    });
    const targets = await collectVerificationTargets(problemOf(workspace), source);
    expect(!targets.ok && targets.reason).toEqual({ kind: 'no-cases' });
  });

  it('does not run when a referenced solution is missing from the folder', async () => {
    const { workspace, source } = await setup({
      ...FILES,
      'max.problem.yaml':
        'format: tc-problem/1\nid: max\nstatement: max.md\nsolutions: [無い.c]\ncases: max.cases.yaml\n',
    });
    const targets = await collectVerificationTargets(problemOf(workspace), source);
    expect(!targets.ok && targets.reason).toEqual({ kind: 'missing-file', path: '無い.c' });
  });

  it('does not run when the cases file has no cases', async () => {
    const { workspace, source } = await setup({ ...FILES, 'max.cases.yaml': 'format: tc-cases/1\ncases: []\n' });
    const targets = await collectVerificationTargets(problemOf(workspace), source);
    expect(!targets.ok && targets.reason).toEqual({ kind: 'empty-cases', path: 'max.cases.yaml' });
  });

  it('does not run when the cases file is not a readable definition', async () => {
    const { workspace, source } = await setup({ ...FILES, 'max.cases.yaml': 'format: tc-cases/9\ncases: []\n' });
    const targets = await collectVerificationTargets(problemOf(workspace), source);
    expect(!targets.ok && targets.reason.kind === 'cases-invalid' && targets.reason.path).toBe('max.cases.yaml');
  });

  it('does not run when a file cannot be read', async () => {
    const { workspace } = await setup();
    const failing: VerificationSource = {
      readText: async (path) => {
        if (path === 'max.cases.yaml') throw new Error('locked');
        return 'x';
      },
    };
    const targets = await collectVerificationTargets(problemOf(workspace), failing);
    expect(!targets.ok && targets.reason.kind === 'read-failed' && targets.reason.path).toBe('max.cases.yaml');
  });

  it('does not run an unreadable problem definition', async () => {
    const { workspace, source } = await setup({ ...FILES, '壊れた.problem.yaml': 'format: tc-problem/99\n' });
    const targets = await collectVerificationTargets(problemOf(workspace, '壊れた.problem.yaml'), source);
    expect(!targets.ok && targets.reason).toEqual({ kind: 'problem-invalid', path: '壊れた.problem.yaml' });
  });
});
