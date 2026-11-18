/**
 * 試験定義のフォームの状態 (`examForm.ts`) のテスト (#797)。操作が試験定義のテキストへ正しく書き戻されること
 * (コメントを残す・同じ問題を 2 回採用しない) と、採用した問題と未採用の問題の一覧を固定する。
 */

import { describe, expect, it } from 'vitest';
import type { WorkspaceIndex } from '../authorWorkspace.js';
import { parseExamDefinition } from '../definitions.js';
import { applyExamFormOp, examFormModel, type ExamFormOp, parseLanguageList } from '../examForm.js';

const EXAM_PATH = '試験/中間.exam.yaml';
const TEXT = [
  'format: tc-exam/1',
  '# 中間試験の定義',
  'examId: midterm',
  'kind: exam',
  'languages: [c]',
  'problems:',
  '  - ../最大値.problem.yaml # 1 問目',
  '',
].join('\n');

function apply(text: string, ...ops: ExamFormOp[]): string {
  let current = text;
  for (const op of ops) {
    const result = applyExamFormOp(EXAM_PATH, current, op);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    current = result.text;
  }
  return current;
}

function definition(text: string) {
  const parsed = parseExamDefinition(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.value;
}

function index(): WorkspaceIndex {
  const ok = (path: string, id: string, title?: string) => ({
    status: 'ok' as const,
    path,
    definition: { id, statement: `${id}.md`, hints: [], solutions: [], ...(title ? { title } : {}) },
    parts: [],
  });
  return {
    files: [],
    problems: [
      ok('合計.problem.yaml', '合計'),
      ok('最大値.problem.yaml', '最大値', '数列の最大値'),
      { status: 'invalid', path: '壊れた.problem.yaml', issues: [{ kind: 'not-a-mapping' }] },
      ok('過去問/探索.problem.yaml', '探索'),
    ],
    exams: [EXAM_PATH],
    examDefinitions: [],
  };
}

describe('applyExamFormOp', () => {
  it('adopts a problem with a reference relative to the exam definition', () => {
    const text = apply(TEXT, { kind: 'adopt', problemPath: '過去問/探索.problem.yaml' });
    expect(definition(text).problems).toEqual(['../最大値.problem.yaml', '../過去問/探索.problem.yaml']);
  });

  it('refuses to adopt a problem that is already adopted', () => {
    expect(applyExamFormOp(EXAM_PATH, TEXT, { kind: 'adopt', problemPath: '最大値.problem.yaml' })).toEqual({
      ok: false,
      error: { kind: 'already-adopted', problemPath: '最大値.problem.yaml' },
    });
  });

  it('moves and removes adopted problems in the given order', () => {
    const text = apply(
      TEXT,
      { kind: 'adopt', problemPath: '合計.problem.yaml' },
      { kind: 'adopt', problemPath: '過去問/探索.problem.yaml' },
      { kind: 'move', from: 2, to: 0 },
      { kind: 'remove', index: 1 }
    );
    expect(definition(text).problems).toEqual(['../過去問/探索.problem.yaml', '../合計.problem.yaml']);
  });

  it('keeps comments in the definition while the form edits it', () => {
    const text = apply(
      TEXT,
      { kind: 'set-exam-id', examId: 'final' },
      { kind: 'set-kind', examKind: 'class' },
      { kind: 'set-languages', languages: ['c', 'python'] },
      { kind: 'adopt', problemPath: '合計.problem.yaml' }
    );
    expect([text.includes('# 中間試験の定義'), text.includes('# 1 問目'), definition(text)]).toEqual([
      true,
      true,
      {
        examId: 'final',
        kind: 'class',
        languages: ['c', 'python'],
        problems: ['../最大値.problem.yaml', '../合計.problem.yaml'],
      },
    ]);
  });

  it('rejects a move whose position is outside the adopted problems', () => {
    expect(applyExamFormOp(EXAM_PATH, TEXT, { kind: 'move', from: 0, to: 1 })).toEqual({
      ok: false,
      error: { kind: 'out-of-range', index: 1 },
    });
  });

  it('rejects an empty examId without producing a text', () => {
    const result = applyExamFormOp(EXAM_PATH, TEXT, { kind: 'set-exam-id', examId: ' ' });
    expect(!result.ok && result.error.kind).toBe('invalid-definition');
  });

  it('reports a definition that cannot be parsed', () => {
    const result = applyExamFormOp(EXAM_PATH, 'format: tc-exam/1\nkind: [\n', { kind: 'remove', index: 0 });
    expect(!result.ok && result.error.kind).toBe('invalid-definition');
  });
});

describe('examFormModel', () => {
  it('lists adopted problems in order and the readable unadopted ones as available', () => {
    const exam = definition(apply(TEXT, { kind: 'adopt', problemPath: '過去問/探索.problem.yaml' }));
    const model = examFormModel(EXAM_PATH, exam, index());
    expect([
      model.adopted.map((p) => [p.path, p.state, p.label]),
      model.available.map((p) => [p.path, p.label]),
    ]).toEqual([
      [
        ['最大値.problem.yaml', 'ok', '数列の最大値'],
        ['過去問/探索.problem.yaml', 'ok', '探索'],
      ],
      [['合計.problem.yaml', '合計']],
    ]);
  });

  it('keeps an adopted problem whose definition is missing or unreadable in the list', () => {
    const exam = {
      examId: 'm',
      kind: 'exam' as const,
      languages: ['c'],
      problems: ['../消えた.problem.yaml', '../壊れた.problem.yaml', '../../外.problem.yaml'],
    };
    const model = examFormModel(EXAM_PATH, exam, index());
    expect(model.adopted.map((p) => [p.reference, p.path, p.state])).toEqual([
      ['../消えた.problem.yaml', '消えた.problem.yaml', 'missing'],
      ['../壊れた.problem.yaml', '壊れた.problem.yaml', 'invalid'],
      ['../../外.problem.yaml', null, 'missing'],
    ]);
  });

  it('marks the second adoption of the same problem as a duplicate', () => {
    const exam = {
      examId: 'm',
      kind: 'exam' as const,
      languages: ['c'],
      problems: ['../合計.problem.yaml', '../合計.problem.yaml'],
    };
    expect(examFormModel(EXAM_PATH, exam, index()).adopted.map((p) => p.duplicate)).toEqual([false, true]);
  });
});

describe('parseLanguageList', () => {
  it('splits by commas, trims, and drops empty and repeated languages', () => {
    expect(parseLanguageList(' c, python,, c ,')).toEqual(['c', 'python']);
  });
});
