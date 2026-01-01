/**
 * ZIP file handling
 *
 * Uses shared file processing utilities from @typedcode/shared.
 */

import { readFile } from 'node:fs/promises';
import { extractFirstProofFromZip, type ProofFile } from '@typedcode/shared';

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
