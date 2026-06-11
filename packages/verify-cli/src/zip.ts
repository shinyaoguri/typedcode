/**
 * ZIP file handling
 *
 * Uses shared file processing utilities from @typedcode/shared.
 */

import { readFile } from 'node:fs/promises';
import {
  extractFirstProofFromZip,
  extractAllProofsFromZip,
  type ProofFile,
} from '@typedcode/shared';

export async function extractProofFromZip(filePath: string): Promise<ProofFile> {
  const buffer = await readFile(filePath);
  // Convert Buffer to ArrayBuffer
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );
  const proof = await extractFirstProofFromZip(arrayBuffer);
  return proof as ProofFile;
}

/**
 * ZIP 内の **すべて** の proof JSON を返す (exam/class はタブ毎に N 個出力されるため)。
 * grader は全件を検証して初めて exit 0 にできる。
 */
export async function extractAllProofs(
  filePath: string
): Promise<Array<{ filename: string; proof: ProofFile }>> {
  const buffer = await readFile(filePath);
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );
  const proofs = await extractAllProofsFromZip(arrayBuffer);
  return proofs.map((p) => ({ filename: p.filename, proof: p.proof as ProofFile }));
}
