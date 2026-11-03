/**
 * `--extract-sources` の書き出し先の名前と、`<dir>` の外へ書かない保証 (#409)。
 *
 * 名前は ZIP エントリ名と proof.filename から作る。どちらも攻撃者が書けるので、パス区切り・`..`・
 * 絶対パスで書き出し先の外へ出られないことを、純関数 (無害化) と実際の書き込み (一時ディレクトリ) の両方で固定する。
 * CLI 全体の挙動 (exit code・出力の構成) は `cliExtractSources.test.ts` が持つ。
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createDirNamer,
  extractProofSources,
  proofDirBase,
  sanitizeEntryName,
  sanitizeExtension,
  type ExtractProofSourcesInput,
} from '../extractSources.js';

const HOSTILE = [
  '../x',
  '../../etc/passwd',
  '/etc/passwd',
  'C:\\Windows\\system32\\x',
  '..\\..\\x',
  'a/../../b',
  '..',
  '.hidden',
  '...x',
  '.',
  '',
  'x\u0000y',
  'x\ny\u001b[31m',
];

describe('sanitizeEntryName', () => {
  it.each(HOSTILE)('never yields a path separator, a dot-dot or an empty name for %j', (raw) => {
    const name = sanitizeEntryName(raw);

    expect(name).not.toMatch(/[\\/]/);
    expect([...name].some((ch) => ch.charCodeAt(0) < 0x20)).toBe(false);
    expect(name).not.toMatch(/^\./);
    expect(name).not.toBe('');
    expect(name).not.toBe('..');
  });

  it('keeps only the last path segment of an entry name', () => {
    expect(sanitizeEntryName('sub/dir/main_proof')).toBe('main_proof');
    expect(sanitizeEntryName('../../evil_proof')).toBe('evil_proof');
  });

  it('keeps letters from any script so that Japanese tab names stay readable', () => {
    expect(sanitizeEntryName('課題1_proof')).toBe('課題1_proof');
  });

  it('does not let a Windows reserved device name through', () => {
    expect(sanitizeEntryName('CON')).not.toMatch(/^con$/i);
    expect(sanitizeEntryName('nul.txt')).not.toMatch(/^nul(\.|$)/i);
  });

  it('bounds the length of the name', () => {
    expect(sanitizeEntryName('a'.repeat(500)).length).toBeLessThanOrEqual(100);
  });
});

describe('sanitizeExtension', () => {
  it('keeps an ordinary extension', () => {
    expect(sanitizeExtension('js')).toBe('js');
  });

  it.each(['../x', 'j/s', 'js\u0000', '', 'a'.repeat(40)])('falls back to txt for %j', (raw) => {
    expect(sanitizeExtension(raw)).toBe('txt');
  });
});

describe('proofDirBase', () => {
  it('drops the folder and the .json suffix of a proof entry', () => {
    expect(proofDirBase('sub/main_proof_1.json')).toBe('main_proof_1');
    expect(proofDirBase('../../evil_proof.json')).toBe('evil_proof');
  });
});

describe('createDirNamer', () => {
  it('gives a second claim of the same name a distinct name', () => {
    const name = createDirNamer();

    expect(name('main_proof')).toBe('main_proof');
    expect(name('main_proof')).toBe('main_proof_2');
    expect(name('main_proof')).toBe('main_proof_3');
  });

  it('treats names that differ only by case as the same name (case-insensitive file systems)', () => {
    const name = createDirNamer();

    name('Main_proof');

    expect(name('main_PROOF').toLowerCase()).not.toBe('main_proof');
  });
});

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'tc-extract-unit-'));
}

function input(outDir: string, overrides: Partial<ExtractProofSourcesInput> = {}): ExtractProofSourcesInput {
  return {
    outDir,
    namer: createDirNamer(),
    input: 'export.zip',
    proofEntry: 'main_proof.json',
    proofFilename: 'main.js',
    language: 'javascript',
    content: 'ok',
    pair: { proofPath: 'main_proof.json', status: 'match', expectedSource: 'main.js' },
    sourceBytes: new TextEncoder().encode('ok'),
    verification: { kind: 'completed', valid: true, chainValid: true, metadataValid: true, integrity: 'proven' },
    ...overrides,
  };
}

describe('extractProofSources', () => {
  it('writes only inside the output directory even when the entry names and proof.filename are hostile', async () => {
    const root = tmp();
    const outDir = join(root, 'out');
    const namer = createDirNamer();

    for (const hostile of HOSTILE) {
      await extractProofSources(
        input(outDir, {
          namer,
          proofEntry: `${hostile}_proof.json`,
          proofFilename: hostile,
          pair: { proofPath: `${hostile}_proof.json`, status: 'match', expectedSource: `${hostile}.js` },
        })
      );
    }

    // outDir と同じ階層・上位には何も増えていない
    expect(readdirSync(root)).toEqual(['out']);
    // 書かれたものは outDir の直下の 1 階層のディレクトリだけ
    for (const entry of readdirSync(outDir, { withFileTypes: true })) {
      expect(entry.isDirectory()).toBe(true);
      expect(readdirSync(join(outDir, entry.name)).sort()).toEqual(['report.json', 'submitted.js', 'verified.js']);
    }
  });

  it('refuses to write into a proof directory that already exists and leaves its files untouched', async () => {
    const outDir = tmp();
    mkdirSync(join(outDir, 'main_proof'));
    writeFileSync(join(outDir, 'main_proof', 'submitted.js'), 'PRECIOUS');

    await expect(extractProofSources(input(outDir))).rejects.toThrow(/already exists/);

    expect(readFileSync(join(outDir, 'main_proof', 'submitted.js'), 'utf-8')).toBe('PRECIOUS');
    expect(readdirSync(join(outDir, 'main_proof'))).toEqual(['submitted.js']);
  });

  it('does not follow a symbolic link planted at the proof directory name', async () => {
    const root = tmp();
    const outDir = join(root, 'out');
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(outDir);
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(outDir, 'main_proof'));

    await expect(extractProofSources(input(outDir))).rejects.toThrow();

    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('writes submitted only for a pair that matched or mismatched', async () => {
    const outDir = tmp();

    const missing = await extractProofSources(
      input(outDir, {
        proofEntry: 'a_proof.json',
        pair: { proofPath: 'a_proof.json', status: 'missing-source', expectedSource: 'a.js' },
        sourceBytes: undefined,
      })
    );
    const ambiguous = await extractProofSources(
      input(outDir, {
        proofEntry: 'b_proof.json',
        pair: { proofPath: 'b_proof.json', status: 'ambiguous', expectedSource: 'b.js', reason: 'x' },
        sourceBytes: new TextEncoder().encode('someone else'),
      })
    );

    expect(missing.files).not.toContain('submitted.js');
    expect(ambiguous.files).not.toContain('submitted.js');
    expect(existsSync(join(outDir, 'b_proof', 'submitted.js'))).toBe(false);
  });

  it('writes no verified file when the proof itself failed verification, and says why in report.json', async () => {
    const outDir = tmp();

    await extractProofSources(
      input(outDir, {
        verification: { kind: 'completed', valid: false, chainValid: false, metadataValid: true, integrity: 'failed' },
      })
    );

    expect(existsSync(join(outDir, 'main_proof', 'verified.js'))).toBe(false);
    const report = JSON.parse(readFileSync(join(outDir, 'main_proof', 'report.json'), 'utf-8'));
    expect(report.files.verified).toBeNull();
    expect(report.files.submitted).toBe('submitted.js');
  });

  it('writes submitted bytes exactly, including a BOM and CRLF', async () => {
    const outDir = tmp();
    const raw = new Uint8Array([0xef, 0xbb, 0xbf, 0x6f, 0x0d, 0x0a, 0x6b]);

    await extractProofSources(
      input(outDir, {
        pair: { proofPath: 'main_proof.json', status: 'mismatch', expectedSource: 'main.js' },
        sourceBytes: raw,
      })
    );

    expect(new Uint8Array(readFileSync(join(outDir, 'main_proof', 'submitted.js')))).toEqual(raw);
  });
});
