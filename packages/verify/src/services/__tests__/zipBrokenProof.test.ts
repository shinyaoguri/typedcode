/**
 * ZIP 内の壊れた `*_proof.json` を通常の JSON として並べない (#292)。
 *
 * かつて ZipFileProcessor は JSON.parse に失敗した `*_proof.json` を黙って plaintext (= success) として
 * 取り込んだ。壊れた proof が赤にならず、ただの JSON として一覧に紛れた。契約: proof の命名に当たるのに
 * proof として読めないファイルは `type: 'proof'` のまま (proofData 無し) 返し、取り込み側が error にする。
 * 命名に当たらない JSON (manifest・設定など) は従来どおり plaintext。
 */

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { ZipFileProcessor } from '../ZipFileProcessor.js';

const VALID = JSON.stringify({ language: 'typescript', proof: { events: [] } });

async function processZip(entries: Record<string, string>) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  const buffer = await zip.generateAsync({ type: 'arraybuffer' });
  const result = await new ZipFileProcessor().process(new File([buffer], 'export.zip'));
  expect(result.success).toBe(true);
  return new Map(result.files.map((f) => [f.filename, f]));
}

describe('ZipFileProcessor with broken proofs (#292)', () => {
  it('keeps a malformed *_proof.json as a proof entry without proofData', async () => {
    const files = await processZip({ 'a_proof.json': VALID, 'b_proof.json': '{"proof":' });

    expect(files.get('a_proof.json')?.type).toBe('proof');
    expect(files.get('a_proof.json')?.proofData).toBeDefined();
    expect(files.get('b_proof.json')?.type).toBe('proof');
    expect(files.get('b_proof.json')?.proofData).toBeUndefined();
    expect(files.get('b_proof.json')?.rawData).toBe('{"proof":');
  });

  it('keeps well-formed JSON without proof structure under a proof name as a proof entry', async () => {
    const files = await processZip({ 'b_proof.json': '{"hello":1}' });

    expect(files.get('b_proof.json')?.type).toBe('proof');
    expect(files.get('b_proof.json')?.proofData).toBeUndefined();
  });

  it('applies to the duplicate-name form (main_proof_1.json) and to subfolders', async () => {
    const files = await processZip({ 'main_proof_1.json': '{', 'sub/x_proof.json': '[]' });

    expect(files.get('main_proof_1.json')?.type).toBe('proof');
    expect(files.get('x_proof.json')?.type).toBe('proof');
  });

  it('leaves unrelated JSON as plaintext, valid or not', async () => {
    const files = await processZip({
      'a_proof.json': VALID,
      'tab-switches.json': '[]',
      'settings.json': '{broken',
    });

    expect(files.get('tab-switches.json')?.type).toBe('plaintext');
    expect(files.get('settings.json')?.type).toBe('plaintext');
  });
});
