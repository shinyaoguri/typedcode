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
  type ProofExtractionFailure,
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
 *
 * proof の名前 (`*_proof.json`) なのに読めなかったファイルは `failures` に入る (#292)。
 * 呼び出し側は 1 件でもあれば失敗として数えること — 黙って捨てると、壊れたタブが未検証のまま通る。
 */
export async function extractAllProofs(
  filePath: string
): Promise<{ proofs: Array<{ filename: string; proof: ProofFile }>; failures: ProofExtractionFailure[] }> {
  const arrayBuffer = toArrayBuffer(await readFile(filePath));
  const { proofs, failures } = await extractAllProofsFromZip(arrayBuffer);
  return { proofs: proofs.map((p) => ({ filename: p.filename, proof: p.proof as ProofFile })), failures };
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
