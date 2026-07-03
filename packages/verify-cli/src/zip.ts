/**
 * ZIP file handling
 *
 * Uses shared file processing utilities from @typedcode/shared.
 */

import { readFile } from 'node:fs/promises';
import {
  extractFirstProofFromZip,
  extractAllProofsFromZip,
  extractScreenshotArtifactsFromZip,
  type ProofFile,
} from '@typedcode/shared';

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

export async function extractProofFromZip(filePath: string): Promise<ProofFile> {
  const arrayBuffer = toArrayBuffer(await readFile(filePath));
  const proof = await extractFirstProofFromZip(arrayBuffer);
  return proof as ProofFile;
}

/**
 * ZIP 内の **すべて** の proof JSON を返す (exam/class はタブ毎に N 個出力されるため)。
 * grader は全件を検証して初めて exit 0 にできる。
 */
export async function extractAllProofs(filePath: string): Promise<Array<{ filename: string; proof: ProofFile }>> {
  const arrayBuffer = toArrayBuffer(await readFile(filePath));
  const proofs = await extractAllProofsFromZip(arrayBuffer);
  return proofs.map((p) => ({ filename: p.filename, proof: p.proof as ProofFile }));
}

/**
 * ZIP から screenshots/manifest.json の entry 群と画像バイト列を取り出す (#147)。
 * 判定はしない (shared の summarizeScreenshotArtifacts に委譲)。manifest 無しは null。
 */
export async function extractScreenshotArtifacts(filePath: string): Promise<{
  entries: Array<{ filename: string; imageHash: string }>;
  images: Map<string, ArrayBuffer>;
} | null> {
  const arrayBuffer = toArrayBuffer(await readFile(filePath));
  return extractScreenshotArtifactsFromZip(arrayBuffer);
}
