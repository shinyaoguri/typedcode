/**
 * `--result-json` (#588): 検証の結論を「どの検査で落ちたか」まで機械可読に書き出す。
 * advisory なので exit code には干渉しない。実プロセスで固定する。
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { fixture, runSourceCli } from './helpers/runCli.js';

const VALID = fixture('proofs', 'valid.json');
const TAMPERED = fixture('proofs', 'tampered.json');

interface Entry {
  filename: string;
  valid: boolean;
  integrityValid: boolean;
  failedCheck: string | null;
  errorMessage: string | null;
  rootAnchored: boolean;
  temporal: string | null;
  policyViolations: string[];
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tc-verify-cli-result-'));
}

function runWithResult(args: string[]): { exitCode: number | null; entries: Entry[] } {
  const out = join(tempDir(), 'result.json');
  const res = runSourceCli([...args, '--result-json', out]);
  return { exitCode: res.exitCode, entries: JSON.parse(readFileSync(out, 'utf-8')) as Entry[] };
}

describe('--result-json (#588)', () => {
  it('a valid proof: valid, no failedCheck, no error', () => {
    const { exitCode, entries } = runWithResult([VALID]);

    expect(exitCode).toBe(0);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      filename: VALID,
      valid: true,
      integrityValid: true,
      failedCheck: null,
      errorMessage: null,
      rootAnchored: false,
      policyViolations: [],
    });
    expect(typeof entries[0]!.temporal).toBe('string');
  });

  it('a tampered proof names the layer that failed', () => {
    const { exitCode, entries } = runWithResult([TAMPERED]);

    expect(exitCode).toBe(1);
    expect(entries[0]!.valid).toBe(false);
    expect(entries[0]!.integrityValid).toBe(false);
    expect(entries[0]!.failedCheck).not.toBeNull();
    expect(entries[0]!.errorMessage).toEqual(expect.any(String));
  });

  it('a policy violation fails with failedCheck policy while integrity stays valid', () => {
    const { exitCode, entries } = runWithResult([VALID, '--require-signed-checkpoints']);

    expect(exitCode).toBe(1);
    expect(entries[0]).toMatchObject({
      valid: false,
      integrityValid: true,
      failedCheck: 'policy',
      policyViolations: ['signed-checkpoints-missing'],
    });
  });

  it('an unreadable input is listed as failedCheck unreadable, next to the verified one', () => {
    const missing = join(tempDir(), 'nope.json');
    const { exitCode, entries } = runWithResult([VALID, missing]);

    expect(exitCode).toBe(1);
    expect(entries.map((e) => [e.filename, e.valid, e.failedCheck])).toEqual([
      [VALID, true, null],
      [missing, false, 'unreadable'],
    ]);
    expect(entries[1]!.errorMessage).toEqual(expect.any(String));
    expect(entries[1]!.temporal).toBeNull();
  });

  it('a broken proof inside a ZIP is unreadable; the good one is still verified', async () => {
    const zip = new JSZip();
    zip.file('a_proof.json', readFileSync(VALID, 'utf-8'));
    zip.file('b_proof.json', '{"proof":');
    const path = join(tempDir(), 'export.zip');
    writeFileSync(path, await zip.generateAsync({ type: 'uint8array' }));

    const { exitCode, entries } = runWithResult([path]);

    expect(exitCode).toBe(1);
    expect(entries.map((e) => [e.filename, e.failedCheck])).toEqual([
      ['a_proof.json', null],
      ['b_proof.json', 'unreadable'],
    ]);
  });

  it('does not change the exit code: same result with and without the flag', () => {
    const without = runSourceCli([TAMPERED]).exitCode;
    expect(runWithResult([TAMPERED]).exitCode).toBe(without);
  });
});
