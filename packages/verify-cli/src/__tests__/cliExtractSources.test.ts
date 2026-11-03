/**
 * `--extract-sources <dir>` (#409): ZIP の proof ごとに submitted / verified / report.json を書き出す。
 *
 * 採点者が「検証に通ったソース」を取り出す口。不一致や検証失敗でも元の同梱ソースは書き出し、
 * 入力の ZIP と書き出し先の既存ファイルは決して上書きしない。exit code の規約 (#293) は変えない。
 * 実プロセスで固定する (#283)。名前の無害化の境界は `extractSources.test.ts` (unit)。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { fixture, runSourceCli } from './helpers/runCli.js';

const VALID = readFileSync(fixture('proofs', 'valid.json'), 'utf-8');

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'tc-verify-cli-extract-'));
}

async function writeZip(entries: Record<string, string | Uint8Array>): Promise<string> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  const path = join(tmp(), 'export.zip');
  writeFileSync(path, await zip.generateAsync({ type: 'uint8array' }));
  return path;
}

/** `filename` / `language` を差し替えた proof (チェーンは有効なまま)。content は metadata ハッシュに入るので差し替えない。 */
function proofWith(overrides: Record<string, unknown>): string {
  return JSON.stringify({ ...JSON.parse(VALID), ...overrides });
}

/** チェーンの hash を壊した proof (検証に失敗する)。 */
function tamperedChain(): string {
  const proof = JSON.parse(VALID);
  proof.proof.events[1].hash = 'f'.repeat(64);
  return JSON.stringify(proof);
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function report(dir: string) {
  return JSON.parse(readFileSync(join(dir, 'report.json'), 'utf-8'));
}

describe('--extract-sources (#409)', () => {
  it('writes submitted and verified byte-for-byte and marks the report as match', async () => {
    const zip = await writeZip({ 'valid_proof.json': VALID, 'valid.js': 'ok' });
    const out = join(tmp(), 'out');

    const res = runSourceCli([zip, '--mode', 'full', '--extract-sources', out]);

    expect(res.exitCode).toBe(0);
    expect(readdirSync(join(out, 'valid_proof')).sort()).toEqual(['report.json', 'submitted.js', 'verified.js']);
    expect(readFileSync(join(out, 'valid_proof', 'submitted.js'), 'utf-8')).toBe('ok');
    expect(readFileSync(join(out, 'valid_proof', 'verified.js'), 'utf-8')).toBe('ok');
    const r = report(join(out, 'valid_proof'));
    expect(r.submission.status).toBe('match');
    expect(r.verification.valid).toBe(true);
    expect(r.files).toEqual({ submitted: 'submitted.js', verified: 'verified.js' });
  });

  it('keeps the exit code 1 on a mismatch and writes the bundled source and proof.content apart', async () => {
    const zip = await writeZip({
      'valid_proof.json': VALID,
      'valid.js': 'THIS IS NOT THE VERIFIED CONTENT',
    });
    const out = join(tmp(), 'out');

    const res = runSourceCli([zip, '--mode', 'full', '--extract-sources', out]);

    expect(res.exitCode).toBe(1);
    expect(readFileSync(join(out, 'valid_proof', 'submitted.js'), 'utf-8')).toBe('THIS IS NOT THE VERIFIED CONTENT');
    // 検証済みの proof.content (fixture は 'ok')。同梱ソースとは別のファイルになる。
    expect(readFileSync(join(out, 'valid_proof', 'verified.js'), 'utf-8')).toBe('ok');
    expect(report(join(out, 'valid_proof')).submission.status).toBe('mismatch');
  });

  it('still writes submitted and report.json when the proof chain is tampered', async () => {
    const zip = await writeZip({ 'valid_proof.json': tamperedChain(), 'valid.js': 'ok' });
    const out = join(tmp(), 'out');

    const res = runSourceCli([zip, '--mode', 'full', '--extract-sources', out]);

    expect(res.exitCode).toBe(1);
    expect(readFileSync(join(out, 'valid_proof', 'submitted.js'), 'utf-8')).toBe('ok');
    const r = report(join(out, 'valid_proof'));
    expect(r.verification.valid).toBe(false);
    expect(r.verification.chainValid).toBe(false);
    // 検証に通っていない proof.content を「verified」として出さない
    expect(existsSync(join(out, 'valid_proof', 'verified.js'))).toBe(false);
  });

  it('reports a missing source without writing submitted, and keeps the exit code 0', async () => {
    const zip = await writeZip({ 'valid_proof.json': VALID });
    const out = join(tmp(), 'out');

    const res = runSourceCli([zip, '--mode', 'full', '--extract-sources', out]);

    expect(res.exitCode).toBe(0);
    expect(existsSync(join(out, 'valid_proof', 'submitted.js'))).toBe(false);
    expect(readFileSync(join(out, 'valid_proof', 'verified.js'), 'utf-8')).toBe('ok');
    expect(report(join(out, 'valid_proof')).submission.status).toBe('missing-source');
  });

  it('writes one directory per proof of a multi-tab ZIP', async () => {
    const zip = await writeZip({
      'main_proof.json': proofWith({ filename: 'main.c', language: 'c' }),
      'main_proof_1.json': proofWith({ filename: 'main.c', language: 'c' }),
      'main.c': 'ok',
      'main_1.c': 'ok',
    });
    const out = join(tmp(), 'out');

    const res = runSourceCli([zip, '--mode', 'full', '--extract-sources', out]);

    expect(res.exitCode).toBe(0);
    expect(readdirSync(out).sort()).toEqual(['main_proof', 'main_proof_1']);
    expect(existsSync(join(out, 'main_proof_1', 'submitted.c'))).toBe(true);
  });

  it('does not modify the input ZIP', async () => {
    const zip = await writeZip({ 'valid_proof.json': VALID, 'valid.js': 'ok' });
    const before = { hash: sha256(zip), mtime: statSync(zip).mtimeMs };

    runSourceCli([zip, '--mode', 'full', '--extract-sources', join(tmp(), 'out')]);

    expect(sha256(zip)).toBe(before.hash);
    expect(statSync(zip).mtimeMs).toBe(before.mtime);
  });

  it('does not overwrite an existing file in the output directory and exits 1', async () => {
    const zip = await writeZip({ 'valid_proof.json': VALID, 'valid.js': 'ok' });
    const out = tmp();
    mkdirSync(join(out, 'valid_proof'));
    writeFileSync(join(out, 'valid_proof', 'submitted.js'), 'PRECIOUS');
    const before = {
      hash: sha256(join(out, 'valid_proof', 'submitted.js')),
      mtime: statSync(join(out, 'valid_proof', 'submitted.js')).mtimeMs,
    };

    const res = runSourceCli([zip, '--mode', 'full', '--extract-sources', out]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('already exists');
    expect(readFileSync(join(out, 'valid_proof', 'submitted.js'), 'utf-8')).toBe('PRECIOUS');
    expect(sha256(join(out, 'valid_proof', 'submitted.js'))).toBe(before.hash);
    expect(statSync(join(out, 'valid_proof', 'submitted.js')).mtimeMs).toBe(before.mtime);
    expect(readdirSync(join(out, 'valid_proof'))).toEqual(['submitted.js']);
  });

  it('does not write outside the output directory for hostile entry names and proof.filename', async () => {
    const root = tmp();
    const out = join(root, 'out');
    const zip = await writeZip({
      '../../evil_proof.json': proofWith({ filename: '../../escape.js', language: 'javascript' }),
      '../../escape.js': 'ok',
    });

    runSourceCli([zip, '--mode', 'full', '--extract-sources', out]);

    expect(readdirSync(root)).toEqual(['out']);
    expect(readdirSync(out)).toHaveLength(1);
  });

  it('gives each ZIP of a multi-input run its own directory when entry names collide', async () => {
    const zipA = await writeZip({ 'valid_proof.json': VALID, 'valid.js': 'ok' });
    const zipB = await writeZip({ 'valid_proof.json': VALID, 'valid.js': 'ok' });
    const out = join(tmp(), 'out');

    const res = runSourceCli([zipA, zipB, '--mode', 'full', '--extract-sources', out]);

    expect(res.exitCode).toBe(0);
    expect(readdirSync(out).sort()).toEqual(['valid_proof', 'valid_proof_2']);
  });

  it('warns that a lone JSON input has nothing to extract and writes nothing', () => {
    const out = join(tmp(), 'out');

    const res = runSourceCli([fixture('proofs', 'valid.json'), '--mode', 'full', '--extract-sources', out]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain('--extract-sources');
    expect(existsSync(out)).toBe(false);
  });

  it('rejects --extract-sources without a value', () => {
    const res = runSourceCli([fixture('proofs', 'valid.json'), '--extract-sources']);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('requires a value');
  });
});
