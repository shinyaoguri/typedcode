/**
 * 提出物 (ZIP) の対応規則と照合 (#293)
 *
 * 規則の境界を固定する。editor の実出力の形 (同名タブ・拡張子だけが違うタブ) はどちらも全件 match、
 * 偽物を期待名に置く攻撃は mismatch、名前の推測で多対一にしない、を押さえる。
 * ファイル名の付け方そのもの (`exportNaming.ts`) もここで editor の出力形と突き合わせる。
 */

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { createExportNamer, fileExtensionForLanguage, planExportFilenames } from '../fileProcessing/exportNaming.js';
import { extractSubmissionSourcesFromZip } from '../fileProcessing/parser.js';
import {
  isSubmissionSourceEntry,
  matchSubmissionSources,
  submissionSeverity,
  type SubmissionProofInput,
  type SubmissionSourceInput,
} from '../fileProcessing/submissionSources.js';

const enc = new TextEncoder();

function proof(path: string, filename: string, language: string, content: string): SubmissionProofInput {
  return { path, filename, language, content };
}

function source(path: string, text: string): SubmissionSourceInput {
  return { path, bytes: enc.encode(text) };
}

/** 状態を 1 つずつ見るために、結果を `path -> status` に潰す。 */
function statuses(report: ReturnType<typeof matchSubmissionSources>): Record<string, string> {
  return Object.fromEntries(report.pairs.map((p) => [p.proofPath, p.status]));
}

describe('planExportFilenames (editor export naming)', () => {
  it('numbers same-name tabs for both the source and the proof (main.c x 2)', () => {
    const names = planExportFilenames([
      { filename: 'main.c', language: 'c' },
      { filename: 'main.c', language: 'c' },
    ]);
    expect(names).toEqual([
      { source: 'main.c', proof: 'main_proof.json' },
      { source: 'main_1.c', proof: 'main_proof_1.json' },
    ]);
  });

  it('counts sources by full name but proofs by base name (main.c + main.py)', () => {
    const names = planExportFilenames([
      { filename: 'main.c', language: 'c' },
      { filename: 'main.py', language: 'python' },
    ]);
    expect(names).toEqual([
      { source: 'main.c', proof: 'main_proof.json' },
      { source: 'main.py', proof: 'main_proof_1.json' },
    ]);
  });

  it('appends the language extension when the tab name lacks it', () => {
    const next = createExportNamer();
    expect(next({ filename: 'Untitled-1', language: 'typescript' }).source).toBe('Untitled-1.ts');
  });

  it('falls back to txt for a language that is not in the table, including prototype keys', () => {
    expect(fileExtensionForLanguage('cobol')).toBe('txt');
    expect(fileExtensionForLanguage('__proto__')).toBe('txt');
    expect(fileExtensionForLanguage('constructor')).toBe('txt');
  });
});

describe('matchSubmissionSources', () => {
  it('reports a mismatch when the bundled source differs from proof.content', () => {
    const report = matchSubmissionSources({
      proofs: [proof('valid_proof.json', 'valid.js', 'javascript', 'x')],
      sources: [source('valid.js', 'THIS IS NOT THE VERIFIED CONTENT')],
    });
    expect(report.pairs[0]).toMatchObject({
      proofPath: 'valid_proof.json',
      status: 'mismatch',
      expectedSource: 'valid.js',
      mismatch: { proofContentBytes: 1, sourceBytes: 32, firstDifferenceOffset: 0 },
    });
    expect(submissionSeverity(report, report.pairs[0]!)).toBe('failure');
  });

  it('matches a source that is byte-identical to proof.content', () => {
    const report = matchSubmissionSources({
      proofs: [proof('a_proof.json', 'a.c', 'c', 'int main() {}\n')],
      sources: [source('a.c', 'int main() {}\n')],
    });
    expect(statuses(report)).toEqual({ 'a_proof.json': 'match' });
    expect(report.orphanSources).toEqual([]);
  });

  it('pairs same-name tabs in proof-number order (main.c x 2 -> main.c, main_1.c)', () => {
    const report = matchSubmissionSources({
      proofs: [proof('main_proof_1.json', 'main.c', 'c', 'second'), proof('main_proof.json', 'main.c', 'c', 'first')],
      sources: [source('main.c', 'first'), source('main_1.c', 'second')],
    });
    expect(statuses(report)).toEqual({ 'main_proof.json': 'match', 'main_proof_1.json': 'match' });
  });

  it('matches tabs that differ only by extension (main.c + main.py -> main_proof.json / main_proof_1.json)', () => {
    const report = matchSubmissionSources({
      proofs: [
        proof('main_proof.json', 'main.c', 'c', 'int x;'),
        proof('main_proof_1.json', 'main.py', 'python', 'x = 1'),
      ],
      sources: [source('main.c', 'int x;'), source('main.py', 'x = 1')],
    });
    expect(statuses(report)).toEqual({ 'main_proof.json': 'match', 'main_proof_1.json': 'match' });
    expect(report.orphanSources).toEqual([]);
  });

  it('handles a mixed order (main.c / main.py / main.c) the way the editor numbers it', () => {
    const report = matchSubmissionSources({
      proofs: [
        proof('main_proof.json', 'main.c', 'c', 'c0'),
        proof('main_proof_1.json', 'main.py', 'python', 'py'),
        proof('main_proof_2.json', 'main.c', 'c', 'c1'),
      ],
      sources: [source('main.c', 'c0'), source('main.py', 'py'), source('main_1.c', 'c1')],
    });
    expect(Object.values(statuses(report))).toEqual(['match', 'match', 'match']);
  });

  it('does not accept the genuine source under another name when the expected name holds a fake', () => {
    // 本物を valid_1.js、偽物を期待名 valid.js に置く。内容で探して対にすると偽物が孤立 (警告) になるだけで通る。
    const report = matchSubmissionSources({
      proofs: [proof('valid_proof.json', 'valid.js', 'javascript', 'real')],
      sources: [source('valid.js', 'FAKE'), source('valid_1.js', 'real')],
    });
    expect(report.pairs[0]?.status).toBe('mismatch');
    expect(report.orphanSources).toEqual(['valid_1.js']);
  });

  it('reports missing-source as a warning when the expected name is absent', () => {
    const report = matchSubmissionSources({
      proofs: [proof('a_proof.json', 'a.c', 'c', 'x')],
      sources: [source('b.c', 'x')],
    });
    expect(report.pairs[0]).toMatchObject({ status: 'missing-source', expectedSource: 'a.c' });
    expect(submissionSeverity(report, report.pairs[0]!)).toBe('warning');
  });

  it('reports a source that no proof expects as an orphan', () => {
    const report = matchSubmissionSources({
      proofs: [proof('a_proof.json', 'a.c', 'c', 'x')],
      sources: [source('a.c', 'x'), source('extra.py', 'print()')],
    });
    expect(report.orphanSources).toEqual(['extra.py']);
    expect(statuses(report)).toEqual({ 'a_proof.json': 'match' });
  });

  it.each([
    ['CRLF line endings', 'a\r\nb', 'a\nb'],
    ['a UTF-8 BOM', '﻿a', 'a'],
    ['trailing content', 'abc\n\n', 'abc\n'],
    ['a different Unicode normalization form', 'é', 'é'],
  ])('treats %s as a mismatch (no normalization)', (_label, sourceText, proofContent) => {
    const bytes = sourceText.startsWith('﻿')
      ? new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode(sourceText.slice(1))])
      : enc.encode(sourceText);
    const report = matchSubmissionSources({
      proofs: [proof('a_proof.json', 'a.c', 'c', proofContent)],
      sources: [{ path: 'a.c', bytes }],
    });
    expect(report.pairs[0]?.status).toBe('mismatch');
  });

  it('reports where a longer bundled source starts to differ', () => {
    const report = matchSubmissionSources({
      proofs: [proof('a_proof.json', 'a.c', 'c', 'abc')],
      sources: [source('a.c', 'abcdef')],
    });
    expect(report.pairs[0]?.mismatch).toEqual({ proofContentBytes: 3, sourceBytes: 6, firstDifferenceOffset: 3 });
  });

  it('marks both proofs ambiguous when two proofs expect the same source file (main.c x 2 plus a tab named main_1.c)', () => {
    // editor 自身も main_1.c を 2 つ書いて片方を上書きする形。どちらの proof の対か決められないので推測しない。
    const report = matchSubmissionSources({
      proofs: [
        proof('main_proof.json', 'main.c', 'c', 'a'),
        proof('main_proof_1.json', 'main.c', 'c', 'b'),
        proof('main_1_proof.json', 'main_1.c', 'c', 'b'),
      ],
      sources: [source('main.c', 'a'), source('main_1.c', 'b')],
    });
    expect(statuses(report)).toEqual({
      'main_proof.json': 'match',
      'main_proof_1.json': 'ambiguous',
      'main_1_proof.json': 'ambiguous',
    });
  });

  it('marks later proofs ambiguous when an earlier proof of the same name group is unreadable', () => {
    const report = matchSubmissionSources({
      proofs: [proof('main_proof_1.json', 'main.c', 'c', 'x')],
      unreadableProofPaths: ['main_proof.json'],
      sources: [source('main.c', 'x'), source('main_1.c', 'x')],
    });
    expect(report.pairs[0]?.status).toBe('ambiguous');
    expect(submissionSeverity(report, report.pairs[0]!)).toBe('failure');
  });

  it('marks a proof ambiguous when the number sequence has a gap (a proof was removed)', () => {
    const report = matchSubmissionSources({
      proofs: [proof('main_proof_2.json', 'main.c', 'c', 'x')],
      sources: [source('main_2.c', 'x')],
    });
    expect(report.pairs[0]?.status).toBe('ambiguous');
  });

  it('keeps the groups independent: a broken proof of one name does not affect another name', () => {
    const report = matchSubmissionSources({
      proofs: [proof('b_proof.json', 'b.c', 'c', 'x')],
      unreadableProofPaths: ['a_proof.json'],
      sources: [source('b.c', 'x')],
    });
    expect(report.pairs[0]?.status).toBe('match');
  });

  it('resolves names per folder so sub/main_proof.json pairs with sub/main.c', () => {
    const report = matchSubmissionSources({
      proofs: [proof('sub/main_proof.json', 'main.c', 'c', 'x')],
      sources: [source('sub/main.c', 'x'), source('main.c', 'other')],
    });
    expect(statuses(report)).toEqual({ 'sub/main_proof.json': 'match' });
    expect(report.orphanSources).toEqual(['main.c']);
  });

  it('treats a proof without a string filename or content as uncheckable, failing only when sources exist', () => {
    const noSources = matchSubmissionSources({
      proofs: [{ path: 'a_proof.json', filename: undefined, language: 'c', content: undefined }],
      sources: [],
    });
    expect(noSources.pairs[0]?.status).toBe('uncheckable');
    expect(submissionSeverity(noSources, noSources.pairs[0]!)).toBe('warning');

    const withSource = matchSubmissionSources({
      proofs: [{ path: 'a_proof.json', filename: undefined, language: 'c', content: undefined }],
      sources: [source('a.c', 'THIS IS NOT THE VERIFIED CONTENT')],
    });
    expect(submissionSeverity(withSource, withSource.pairs[0]!)).toBe('failure');
  });

  it('uses the txt extension for a self-reported language outside the table', () => {
    const report = matchSubmissionSources({
      proofs: [proof('a_proof.json', 'a', 'cobol', 'x')],
      sources: [source('a.txt', 'x')],
    });
    expect(report.pairs[0]?.status).toBe('match');
  });
});

describe('isSubmissionSourceEntry', () => {
  it.each(['main.c', 'main_1.c', 'sub/main.py', 'notes.txt'])('treats %s as a source candidate', (name) => {
    expect(isSubmissionSourceEntry(name)).toBe(true);
  });

  it.each([
    'main_proof.json',
    'tab-switches.json',
    'README.md',
    'README.ja.md',
    'screenshots/manifest.json',
    'screenshots/shot.png',
    'sub/screenshots/a.png',
    'folder/',
    '.DS_Store',
    'logo.png',
  ])('does not treat %s as a source candidate', (name) => {
    expect(isSubmissionSourceEntry(name)).toBe(false);
  });
});

describe('extractSubmissionSourcesFromZip', () => {
  it('returns the raw bytes of source entries, keeping a BOM that text decoding would drop', async () => {
    const zip = new JSZip();
    zip.file('a.c', new Uint8Array([0xef, 0xbb, 0xbf, 0x78]));
    zip.file('a_proof.json', '{}');
    zip.file('README.md', 'readme');
    zip.file('screenshots/s.png', 'png');
    const buf = (await zip.generateAsync({ type: 'uint8array' })).buffer as ArrayBuffer;

    const sources = await extractSubmissionSourcesFromZip(buf);

    expect(sources.map((s) => s.path)).toEqual(['a.c']);
    expect(Array.from(sources[0]!.bytes)).toEqual([0xef, 0xbb, 0xbf, 0x78]);
  });
});
