/**
 * 試験定義からの書き出し (#797) を、教材フォルダ (fake) → `AuthorWorkspace.buildExamBundle` → `createDistribution`
 * (生成器) まで通して確かめる。配布物そのもの (`.tcclass` はそのままの文字列、`.tcexam` は shared の関数で復号した
 * 平文) に、解答例・ヒント・非公開ケースの内容が入らないこと、書き出しの前後で教材フォルダが変わらないことを固定する。
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeExamPlaintext, decryptExamPackage } from '@typedcode/shared';
import { createDistribution, type ExamSecrets } from '../distribution.js';
import { AuthorWorkspace } from '../workspace/authorWorkspace.js';
import { applyExamFormOp } from '../workspace/examForm.js';
import { MaterialFolder } from '../workspace/materialFolder.js';
import { FakeFileSystem } from '../workspace/__tests__/fakeDirectoryHandle.js';

// .tcexam の封印と復号は Argon2id を本番パラメータで回すので 1 件あたり数秒かかる (examPackageAuthoring.test.ts と同じ)
vi.setConfig({ testTimeout: 60_000 });

const SECRETS = ['HINT-SECRET', 'SOLUTION-SECRET', 'HIDDEN-STDIN', 'HIDDEN-STDOUT'];

/** 3 問 (最大値・合計・探索) の教材。最大値はヒント・解答例・公開と非公開のケースを持つ */
function material(): Record<string, string> {
  return {
    '最大値.problem.yaml': [
      'format: tc-problem/1',
      'id: 最大値',
      'statement: 最大値.md',
      'starter: 最大値.c',
      'hints: [最大値-ヒント.md]',
      'solutions: [最大値-解答.c]',
      'cases: 最大値.cases.yaml',
      '',
    ].join('\n'),
    '最大値.md': '# 最大値\n',
    '最大値.c': 'int main(void) { return 0; }\n',
    '最大値-ヒント.md': 'HINT-SECRET',
    '最大値-解答.c': 'SOLUTION-SECRET',
    '最大値.cases.yaml': [
      'format: tc-cases/1',
      'cases:',
      '  - name: 公開',
      '    stdin: "3\\n1 8 4\\n"',
      '    stdout: "8\\n"',
      '    public: true',
      '  - name: 非公開',
      '    stdin: "HIDDEN-STDIN"',
      '    stdout: "HIDDEN-STDOUT"',
      '',
    ].join('\n'),
    '合計.problem.yaml': 'format: tc-problem/1\nid: 合計\nstatement: 合計.md\nsolutions: [合計-解答.c]\n',
    '合計.md': '# 合計\n',
    '合計-解答.c': 'SOLUTION-SECRET',
    '探索.problem.yaml': 'format: tc-problem/1\nid: 探索\nstatement: 探索.md\n',
    '探索.md': '# 探索\n',
  };
}

const EMPTY_EXAM = (examId: string, kind: 'exam' | 'class') =>
  `format: tc-exam/1\nexamId: ${examId}\nkind: ${kind}\nlanguages: [c]\nproblems: []\n`;

async function setup(files: Record<string, string>) {
  const fs = new FakeFileSystem('教材', files);
  const workspace = new AuthorWorkspace(new MaterialFolder(fs.root()));
  await workspace.refresh();
  return { fs, workspace };
}

/** 試験定義を文書として開き、フォームの操作を当てて保存する (画面と同じ経路) */
async function editExam(workspace: AuthorWorkspace, path: string, ops: Parameters<typeof applyExamFormOp>[2][]) {
  const opened = await workspace.open(path);
  if (!opened.ok) throw new Error('open failed');
  let text = opened.document.text;
  for (const op of ops) {
    const result = applyExamFormOp(path, text, op);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    text = result.text;
  }
  workspace.setText(path, text);
  expect((await workspace.save(path)).status).toBe('saved');
}

async function exportExam(workspace: AuthorWorkspace, path: string, secrets?: ExamSecrets) {
  const bundle = await workspace.buildExamBundle(path);
  if (bundle.status !== 'ok') throw new Error(`cannot export: ${JSON.stringify(bundle)}`);
  return createDistribution(bundle.exam, bundle.problems, { secrets, now: new Date('2026-06-10T01:00:00.000Z') });
}

let secrets: ExamSecrets;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  secrets = { keyId: 'exam-test-797', jwk: JSON.stringify(jwk), embedPublicKey: false, proctorToken: 'ABCD1234' };
});

describe('exporting an exam definition', () => {
  it('exports only the two adopted problems of three, in the reordered order, and keeps the third in the folder', async () => {
    const { fs, workspace } = await setup({ ...material(), '中間.exam.yaml': EMPTY_EXAM('midterm', 'class') });
    await editExam(workspace, '中間.exam.yaml', [
      { kind: 'adopt', problemPath: '最大値.problem.yaml' },
      { kind: 'adopt', problemPath: '探索.problem.yaml' },
      { kind: 'move', from: 1, to: 0 },
    ]);
    const preview = await workspace.previewExam('中間.exam.yaml');
    const distribution = await exportExam(workspace, '中間.exam.yaml');
    const pkg = JSON.parse(distribution.content) as { bundle: { problems: { problemId: string }[] } };
    expect([
      preview.ok && preview.problems.map((p) => p.problemId),
      pkg.bundle.problems.map((p) => p.problemId),
      fs.readFile('合計.problem.yaml') !== undefined,
    ]).toEqual([['探索', '最大値'], ['探索', '最大値'], true]);
  });

  it('exports from two exam definitions that adopt the same problem', async () => {
    const { workspace } = await setup({
      ...material(),
      '中間.exam.yaml': EMPTY_EXAM('midterm', 'class'),
      '期末.exam.yaml': EMPTY_EXAM('final', 'class'),
    });
    await editExam(workspace, '中間.exam.yaml', [{ kind: 'adopt', problemPath: '合計.problem.yaml' }]);
    await editExam(workspace, '期末.exam.yaml', [
      { kind: 'adopt', problemPath: '探索.problem.yaml' },
      { kind: 'adopt', problemPath: '合計.problem.yaml' },
    ]);
    const midterm = await exportExam(workspace, '中間.exam.yaml');
    const final = await exportExam(workspace, '期末.exam.yaml');
    const ids = (content: string) =>
      (JSON.parse(content) as { bundle: { problems: { problemId: string }[] } }).bundle.problems.map(
        (p) => p.problemId
      );
    expect([midterm.filename, ids(midterm.content), final.filename, ids(final.content)]).toEqual([
      'midterm.tcclass',
      ['合計'],
      'final.tcclass',
      ['探索', '合計'],
    ]);
  });

  it('keeps hints, solutions and hidden cases out of an exported .tcclass', async () => {
    const exam =
      'format: tc-exam/1\nexamId: c\nkind: class\nlanguages: [c]\nproblems: [最大値.problem.yaml, 合計.problem.yaml]\n';
    const { workspace } = await setup({ ...material(), 'c.exam.yaml': exam });
    const distribution = await exportExam(workspace, 'c.exam.yaml');
    expect([
      distribution.content.includes('"stdin": "3\\n1 8 4\\n"'),
      SECRETS.filter((s) => distribution.content.includes(s)),
    ]).toEqual([true, []]);
  });

  it('keeps hints, solutions and hidden cases out of the decrypted plaintext of an exported .tcexam', async () => {
    const exam =
      'format: tc-exam/1\nexamId: e\nkind: exam\nlanguages: [c]\nproblems: [最大値.problem.yaml, 合計.problem.yaml]\n';
    const { workspace } = await setup({ ...material(), 'e.exam.yaml': exam });
    const distribution = await exportExam(workspace, 'e.exam.yaml', secrets);
    if (distribution.kind !== 'exam') throw new Error('expected an exam package');
    const decrypted = await decryptExamPackage(distribution.created.manifest, secrets.proctorToken);
    if (!decrypted.ok) throw new Error('cannot decrypt');
    const decoded = decodeExamPlaintext(decrypted.plaintext);
    expect([
      decoded.kind === 'bundle' && decoded.bundle.problems.map((p) => p.problemId),
      decrypted.plaintext.includes('3\\n1 8 4\\n'),
      SECRETS.filter((s) => decrypted.plaintext.includes(s) || distribution.content.includes(s)),
    ]).toEqual([['最大値', '合計'], true, []]);
  });

  it('leaves the material folder unchanged by exporting', async () => {
    const exam = 'format: tc-exam/1\nexamId: e\nkind: exam\nlanguages: [c]\nproblems: [最大値.problem.yaml]\n';
    const { fs, workspace } = await setup({ ...material(), 'e.exam.yaml': exam });
    const before = fs.snapshot();
    await exportExam(workspace, 'e.exam.yaml', secrets);
    expect(fs.snapshot()).toEqual(before);
  });

  it('refuses to create an exam package without a signing key', async () => {
    const exam = 'format: tc-exam/1\nexamId: e\nkind: exam\nlanguages: [c]\nproblems: [合計.problem.yaml]\n';
    const { workspace } = await setup({ ...material(), 'e.exam.yaml': exam });
    await expect(exportExam(workspace, 'e.exam.yaml')).rejects.toThrow();
  });
});
