/**
 * ZIP に同梱されたソースと proof.content の照合 (#293)
 *
 * かつて CLI は proof JSON しか ZIP から取り出さず、同梱ソースが検証済みの内容と違っても
 * `Verification PASSED` / `Integrity: PROVEN` / exit 0 だった。「CLI が成功した ZIP からソースを取り出して
 * 採点する」運用では、検証したものと採点するものがずれる。契約: 同梱ソースが proof.content と
 * バイト単位で一致しなければ exit 1 (理由は Submission 節)。proof 自体は改ざんされていないので
 * `Integrity: PROVEN` は変えない。欠落・孤立ソースは警告で、exit code に影響しない。
 *
 * 対応規則 (期待ソース名) の境界は shared の `submissionSources.test.ts` が持つ。ここは実プロセスの
 * exit code と出力 (`--- Submission ---` 節) を固定する。子プロセスで起動する (#283)。
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { fixture, runSourceCli } from './helpers/runCli.js';

/** 実 PoSW 付きの有効 proof。`filename: valid` / `language: javascript` / `content: ok` なので、同梱ソースは `valid.js` が期待名。 */
const VALID = readFileSync(fixture('proofs', 'valid.json'), 'utf-8');
const CONTENT = 'ok';

/** `filename` / `language` だけを差し替えた proof (チェーンと content は有効なまま)。 */
function proofFor(filename: string, language: string): string {
  return JSON.stringify({ ...JSON.parse(VALID), filename, language });
}

async function writeZip(entries: Record<string, string | Uint8Array>): Promise<string> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  const path = join(mkdtempSync(join(tmpdir(), 'tc-verify-cli-submission-')), 'export.zip');
  writeFileSync(path, await zip.generateAsync({ type: 'uint8array' }));
  return path;
}

describe('ZIP submission check (#293)', () => {
  it('exits 1 and names the file when the bundled source differs from proof.content', async () => {
    const zip = await writeZip({ 'valid_proof.json': VALID, 'valid.js': 'THIS IS NOT THE VERIFIED CONTENT' });

    const res = runSourceCli([zip, '--mode', 'full']);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toMatch(/^--- Submission ---$/m);
    expect(res.stdout).toMatch(/^Source:\s+valid\.js\s+MISMATCH/m);
    expect(res.stdout).toContain('Verification FAILED');
    expect(res.stdout).toContain('Submission failed');
  });

  it('keeps Integrity: PROVEN because the proof itself is not tampered', async () => {
    const zip = await writeZip({ 'valid_proof.json': VALID, 'valid.js': 'THIS IS NOT THE VERIFIED CONTENT' });

    const res = runSourceCli([zip, '--mode', 'full']);

    expect(res.stdout).toMatch(/^\s*Integrity:\s+PROVEN/m);
    expect(res.stdout).toMatch(/^Hash Chain:\s+PASS/m);
  });

  it('exits 0 when the bundled source is byte-identical to proof.content', async () => {
    const zip = await writeZip({ 'valid_proof.json': VALID, 'valid.js': CONTENT });

    const res = runSourceCli([zip, '--mode', 'full']);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/^Source:\s+valid\.js\s+MATCH/m);
  });

  it('exits 1 when the genuine source is stored as valid_1.js and a fake sits at the expected name', async () => {
    const zip = await writeZip({ 'valid_proof.json': VALID, 'valid.js': 'FAKE', 'valid_1.js': CONTENT });

    const res = runSourceCli([zip, '--mode', 'full']);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toMatch(/^Source:\s+valid\.js\s+MISMATCH/m);
  });

  it.each([
    ['CRLF line endings', 'o\r\nk'],
    ['a trailing newline', 'ok\n'],
  ])('exits 1 for a bundled source with %s (no normalization)', async (_label, text) => {
    const zip = await writeZip({ 'valid_proof.json': VALID, 'valid.js': text });

    expect(runSourceCli([zip, '--mode', 'full']).exitCode).toBe(1);
  });

  it('exits 1 for a bundled source with a UTF-8 BOM', async () => {
    const zip = await writeZip({
      'valid_proof.json': VALID,
      'valid.js': new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(CONTENT)]),
    });

    expect(runSourceCli([zip, '--mode', 'full']).exitCode).toBe(1);
  });

  it('exits 0 for the editor output of same-name tabs (main.c x 2)', async () => {
    const zip = await writeZip({
      'main_proof.json': proofFor('main.c', 'c'),
      'main_proof_1.json': proofFor('main.c', 'c'),
      'main.c': CONTENT,
      'main_1.c': CONTENT,
    });

    const res = runSourceCli([zip, '--mode', 'full']);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain('MISMATCH');
    expect(res.stdout).not.toContain('MISSING');
  });

  it('exits 0 for the editor output of tabs that differ only by extension (main.c + main.py)', async () => {
    const zip = await writeZip({
      'main_proof.json': proofFor('main.c', 'c'),
      'main_proof_1.json': proofFor('main.py', 'python'),
      'main.c': CONTENT,
      'main.py': CONTENT,
    });

    const res = runSourceCli([zip, '--mode', 'full']);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('=== Summary: 2/2 proofs passed ===');
  });

  it('warns about a missing source without changing the exit code', async () => {
    const zip = await writeZip({ 'valid_proof.json': VALID });

    const res = runSourceCli([zip, '--mode', 'full']);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/^Source:\s+MISSING/m);
  });

  it('warns about a source that no proof expects without changing the exit code', async () => {
    const zip = await writeZip({ 'valid_proof.json': VALID, 'valid.js': CONTENT, 'extra.py': 'print()' });

    const res = runSourceCli([zip, '--mode', 'full']);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Source file not matched to any proof: extra.py');
  });

  it('states that a lone JSON input is not checked', () => {
    const res = runSourceCli([fixture('proofs', 'valid.json'), '--mode', 'full']);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/^Submission: not checked/m);
  });

  it('prints the source name safely when a proof self-reports a filename with control characters', async () => {
    const zip = await writeZip({
      'valid_proof.json': proofFor('v\u001b[31mx\nFAKE: line.js', 'javascript'),
      x: 'unrelated',
    });

    const res = runSourceCli([zip, '--mode', 'full']);

    expect(res.stdout).not.toContain('\u001b[31m');
    expect(res.stdout).not.toMatch(/^FAKE: line\.js/m);
  });
});
