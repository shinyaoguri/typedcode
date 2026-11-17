/**
 * 単体 JSON・フォルダで入れた壊れた `*_proof.json` を通常の JSON として並べない (#702)。
 *
 * #292 の規則 (proof の命名に当たるのに proof として読めないファイルは `type: 'proof'` のまま proofData 無しで
 * 返し、取り込み側が error にする) は、かつて ZIP 経路 (`ZipFileProcessor`) にしか効いていなかった。
 * `JsonFileProcessor` は JSON 破損・proof 構造なしを plaintext (= success) で返し、壊れた proof が緑の行に並んだ。
 * 単体投入 (`process`) とフォルダを開く経路 (`processFromHandle` → `process`) は同じ `JsonFileProcessor` を通る。
 */

import { describe, expect, it } from 'vitest';
import { JsonFileProcessor } from '../JsonFileProcessor.js';

const VALID = JSON.stringify({ language: 'typescript', proof: { events: [] } });

async function processJson(name: string, content: string) {
  const result = await new JsonFileProcessor().process(new File([content], name));
  expect(result.success).toBe(true);
  expect(result.files).toHaveLength(1);
  return result.files[0]!;
}

describe('JsonFileProcessor with broken proofs (#702)', () => {
  it('keeps a malformed *_proof.json as a proof entry without proofData', async () => {
    const file = await processJson('a_proof.json', '{"proof":');

    expect(file.type).toBe('proof');
    expect(file.proofData).toBeUndefined();
    expect(file.rawData).toBe('{"proof":');
  });

  it('keeps well-formed JSON without proof structure under a proof name as a proof entry', async () => {
    const file = await processJson('a_proof.json', '{}');

    expect(file.type).toBe('proof');
    expect(file.proofData).toBeUndefined();
  });

  it('applies to the duplicate-name form (main_proof_1.json)', async () => {
    const file = await processJson('main_proof_1.json', '{');

    expect(file.type).toBe('proof');
  });

  it('leaves unrelated JSON as plaintext, valid or not', async () => {
    expect((await processJson('settings.json', '{"a":1}')).type).toBe('plaintext');
    expect((await processJson('settings.json', '{broken')).type).toBe('plaintext');
  });

  it('still reads a well-formed proof under any name as a proof with proofData', async () => {
    const file = await processJson('anything.json', VALID);

    expect(file.type).toBe('proof');
    expect(file.proofData).toBeDefined();
  });
});
