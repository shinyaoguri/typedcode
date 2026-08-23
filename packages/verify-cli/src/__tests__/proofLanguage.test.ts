/**
 * proof 由来の自己申告 `language` は CLI の結果に生値で載せない (#248)。
 *
 * `output.ts` は `Language:        ${result.language}` を stdout に出す。生値のままだと
 * 改行や ANSI を仕込んで偽の `Checks` ブロックを描け、stdout を grep する採点運用を騙せる
 * (#266)。出力境界そのもののサニタイズは #266 で別途行うが、まず結果を組み立てる時点で
 * allowlist に落とす契約をここで固定する。
 */

import { describe, expect, it, vi } from 'vitest';
import { verifyProof, type ProofFile } from '../verify.js';

/** language 以外は最小構成の proof。検証は FAIL してよい (見るのは language だけ)。 */
function proofWithLanguage(language: unknown): ProofFile {
  return {
    version: '1.0.0',
    language,
    content: '',
    metadata: { timestamp: new Date(0).toISOString() },
    typingProofData: { initialEventChainHash: null, finalEventChainHash: null, metadata: {} },
    proof: { events: [], finalHash: '' },
  } as unknown as ProofFile;
}

describe('verifyProof — self-asserted language', () => {
  // 進捗バーが stdout を汚すので黙らせる (検証対象は戻り値)。
  const silence = () => vi.spyOn(console, 'log').mockImplementation(() => {});

  it('passes through a known language', async () => {
    silence();
    const result = await verifyProof(proofWithLanguage('python'), { mode: 'fast' });
    expect(result.language).toBe('python');
  });

  it('drops a language carrying a newline so no fake Checks block can be printed', async () => {
    silence();
    const payload = 'c\n\n--- Checks ---\nHash Chain: PASS';
    const result = await verifyProof(proofWithLanguage(payload), { mode: 'fast' });
    expect(result.language).toBe('unknown');
  });

  it('drops a language carrying an ANSI escape', async () => {
    silence();
    const result = await verifyProof(proofWithLanguage('c\x1b[2K\x1b[1A'), { mode: 'fast' });
    expect(result.language).toBe('unknown');
  });

  it('falls back to unknown for a missing language field', async () => {
    silence();
    const result = await verifyProof(proofWithLanguage(undefined), { mode: 'fast' });
    expect(result.language).toBe('unknown');
  });
});
