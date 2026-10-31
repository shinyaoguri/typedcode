/**
 * ZIP 内の壊れた `*_proof.json` を成功に数えない (#292)。
 *
 * かつて CLI は ZIP 内の JSON.parse 失敗と proof 構造の欠落を黙ってスキップした。有効 proof +
 * `broken_proof.json` の ZIP が PASSED / exit 0 になり、しかも単一 proof 扱いなのでヘッダにも
 * Summary にも壊れたファイル名が出なかった。契約: proof の命名に当たるのに読めないファイルは
 * 失敗として数え (exit 1)、ファイル名と理由を表示し、他の proof の検証は止めない。
 * 命名に当たらない JSON (tab-switches / screenshots manifest など) は従来どおり失敗にしない。
 *
 * 子プロセスで起動する (終了コードは実プロセスの終わり方で決まる, #283)。
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { fixture, runSourceCli } from './helpers/runCli.js';

const VALID = readFileSync(fixture('proofs', 'valid.json'), 'utf-8');

async function writeZip(entries: Record<string, string>): Promise<string> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  const path = join(mkdtempSync(join(tmpdir(), 'tc-verify-cli-zip-')), 'export.zip');
  writeFileSync(path, await zip.generateAsync({ type: 'uint8array' }));
  return path;
}

describe('ZIP with an unreadable *_proof.json (#292)', () => {
  it('valid proof + malformed proof exits 1 and names the broken file', async () => {
    const zip = await writeZip({ 'a_proof.json': VALID, 'b_proof.json': '{"proof":' });

    const res = runSourceCli([zip]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('=== b_proof.json ===');
    expect(res.stdout).toContain('✗ Could not read proof: invalid JSON');
    expect(res.stdout).toContain('=== Summary: 1/2 proofs passed ===');
    expect(res.stdout).toContain('✓ a_proof.json');
    expect(res.stdout).toContain('✗ b_proof.json');
  });

  it('the valid proof is still verified and reported alongside the broken one', async () => {
    const zip = await writeZip({ 'a_proof.json': VALID, 'b_proof.json': '{"proof":' });

    const res = runSourceCli([zip]);

    expect(res.stdout).toContain('=== a_proof.json ===');
    expect(res.stdout).toMatch(/^Hash Chain:\s+PASS/m);
  });

  it('well-formed JSON without proof structure fails the same way', async () => {
    const zip = await writeZip({ 'a_proof.json': VALID, 'other_proof.json': '{"hello":1}' });

    const res = runSourceCli([zip]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('=== other_proof.json ===');
    expect(res.stdout).toContain('not a proof');
  });

  it('a ZIP whose only proof is broken is reported as unreadable, not as "no proof file"', async () => {
    const zip = await writeZip({ 'only_proof.json': '{' });

    const res = runSourceCli([zip]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('=== only_proof.json ===');
    expect(res.stdout).toContain('✗ Could not read proof');
    expect(`${res.stdout}${res.stderr}`).not.toContain('No proof file found');
  });

  it('the duplicate-name form (main_proof_1.json) counts as a proof name', async () => {
    const zip = await writeZip({ 'main_proof.json': VALID, 'main_proof_1.json': '{' });

    const res = runSourceCli([zip]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('✗ main_proof_1.json');
  });

  it('counts toward the multi-input aggregation, with the input name prefixed (#294)', async () => {
    const broken = await writeZip({ 'a_proof.json': VALID, 'b_proof.json': '{' });

    const res = runSourceCli([fixture('proofs', 'valid.json'), broken]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain(`✗ ${broken}:b_proof.json`);
    expect(res.stdout).toContain('=== Summary: 2/3 proofs passed ===');
  });

  it('the broken file does not stop --analysis-json from carrying the verified proof', async () => {
    const zip = await writeZip({ 'a_proof.json': VALID, 'b_proof.json': '{' });
    const out = join(mkdtempSync(join(tmpdir(), 'tc-verify-cli-zip-')), 'analysis.json');

    const res = runSourceCli([zip, '--analysis-json', out]);

    expect(res.exitCode).toBe(1);
    const names = (JSON.parse(readFileSync(out, 'utf-8')) as Array<{ filename: string }>).map((e) => e.filename);
    expect(names).toEqual(['a_proof.json']);
  });

  it('the filename is passed through safe(): control characters cannot forge a line', async () => {
    const zip = await writeZip({ 'a_proof.json': VALID, 'x\u001b[32m\n✓ forged_proof.json': '{' });

    const res = runSourceCli([zip]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).not.toMatch(/^✓ forged_proof\.json/m);
    expect(res.stdout).toContain('(sanitized)');
  });
});

describe('ZIP with only unrelated JSON next to a valid proof (unchanged behaviour)', () => {
  it('tab-switches.json / screenshots manifest / settings JSON do not fail the run', async () => {
    const zip = await writeZip({
      'a_proof.json': VALID,
      'tab-switches.json': '[]',
      'settings.json': '{broken',
      'screenshots/manifest.json': '{}',
    });

    const res = runSourceCli([zip]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain('Could not read proof');
  });

  it('several valid proofs are all verified', async () => {
    const zip = await writeZip({ 'a_proof.json': VALID, 'b_proof.json': VALID, 'c_proof_1.json': VALID });

    const res = runSourceCli([zip]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('=== Summary: 3/3 proofs passed ===');
  });
});
