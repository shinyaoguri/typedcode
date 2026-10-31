/**
 * ZIP 内の壊れた proof を黙って捨てない (#292)。
 *
 * かつて `extractAllProofsFromZip` は JSON.parse の失敗と `isProofFile` 不一致を黙ってスキップした。
 * 有効 proof + 壊れた `*_proof.json` の ZIP が「proof 1 件」として全体 PASS になり、壊れたタブが
 * 未検証のまま通った。契約: proof の命名 (`*_proof.json` / `*_proof_N.json`) に当たるのに proof として
 * 読めないファイルは `failures` に集める。命名に当たらない JSON は従来どおり無視する。
 */

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { ZipExtractionBudget } from '../fileProcessing/zipBudget.js';
import { extractAllProofsFromZip, isProofExportFilename } from '../fileProcessing/parser.js';

const VALID = JSON.stringify({ proof: { events: [] }, typingProofHash: 'abc' });

async function zipOf(entries: Record<string, string>): Promise<ArrayBuffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  const buf = await zip.generateAsync({ type: 'uint8array' });
  return buf.buffer as ArrayBuffer;
}

describe('isProofExportFilename', () => {
  it.each([
    'main_proof.json',
    'main_proof_1.json',
    'main_proof_12.json',
    'sub/dir/main_proof.json',
    'MAIN_PROOF.JSON',
    '_proof.json',
  ])('treats %s as a proof name', (name) => {
    expect(isProofExportFilename(name)).toBe(true);
  });

  it.each([
    'proof.json',
    'main.json',
    'tab-switches.json',
    'manifest.json',
    'main_proof.json.bak',
    'main_proof_x.json',
    'main_proofs.json',
    'my_proof/other.json',
  ])('does not treat %s as a proof name', (name) => {
    expect(isProofExportFilename(name)).toBe(false);
  });
});

describe('extractAllProofsFromZip failures (#292)', () => {
  it('reports a malformed *_proof.json as invalid-json and still returns the valid proof', async () => {
    const { proofs, failures } = await extractAllProofsFromZip(
      await zipOf({ 'a_proof.json': VALID, 'b_proof.json': '{"proof":' })
    );

    expect(proofs.map((p) => p.filename)).toEqual(['a_proof.json']);
    expect(failures).toEqual([{ filename: 'b_proof.json', reason: 'invalid-json' }]);
  });

  it('reports well-formed JSON without a proof object as not-a-proof', async () => {
    const { proofs, failures } = await extractAllProofsFromZip(await zipOf({ 'b_proof.json': '{"hello":1}' }));

    expect(proofs).toEqual([]);
    expect(failures).toEqual([{ filename: 'b_proof.json', reason: 'not-a-proof' }]);
  });

  it('treats a proof whose "proof" is not an object as not-a-proof', async () => {
    const { failures } = await extractAllProofsFromZip(await zipOf({ 'b_proof.json': '{"proof":"x"}' }));

    expect(failures).toEqual([{ filename: 'b_proof.json', reason: 'not-a-proof' }]);
  });

  it('applies the same rule to the duplicate-name form (main_proof_1.json)', async () => {
    const { proofs, failures } = await extractAllProofsFromZip(
      await zipOf({ 'main_proof.json': VALID, 'main_proof_1.json': '{' })
    );

    expect(proofs.map((p) => p.filename)).toEqual(['main_proof.json']);
    expect(failures).toEqual([{ filename: 'main_proof_1.json', reason: 'invalid-json' }]);
  });

  it('returns every valid proof and lists failures in filename order', async () => {
    const { proofs, failures } = await extractAllProofsFromZip(
      await zipOf({
        'z_proof.json': '{',
        'a_proof.json': VALID,
        'c_proof.json': VALID,
        'b_proof.json': '[]',
      })
    );

    expect(proofs.map((p) => p.filename)).toEqual(['a_proof.json', 'c_proof.json']);
    expect(failures.map((f) => f.filename)).toEqual(['b_proof.json', 'z_proof.json']);
  });

  it('ignores unrelated JSON (config, tab-switches, screenshots manifest) even when malformed', async () => {
    const { proofs, failures } = await extractAllProofsFromZip(
      await zipOf({
        'a_proof.json': VALID,
        'tab-switches.json': '[]',
        'settings.json': '{broken',
        'notes.json': '{"hello":1}',
        'screenshots/manifest.json': '{}',
        'screenshots/broken_proof.json': '{',
      })
    );

    expect(proofs.map((p) => p.filename)).toEqual(['a_proof.json']);
    expect(failures).toEqual([]);
  });

  it('still extracts a structurally valid proof whose name does not follow the convention', async () => {
    const { proofs, failures } = await extractAllProofsFromZip(await zipOf({ 'weird.json': VALID }));

    expect(proofs.map((p) => p.filename)).toEqual(['weird.json']);
    expect(failures).toEqual([]);
  });

  it('still goes through the budget: an over-budget entry throws instead of being reported', async () => {
    const big = JSON.stringify({ proof: { events: [] }, pad: 'x'.repeat(4096) });

    await expect(
      extractAllProofsFromZip(await zipOf({ 'a_proof.json': big }), new ZipExtractionBudget(1024))
    ).rejects.toThrow();
  });
});
