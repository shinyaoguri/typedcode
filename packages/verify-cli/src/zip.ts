/**
 * ZIP file handling
 */

import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import type { ExportedProof } from '@typedcode/shared';

export interface ProofFile extends ExportedProof {
  content: string;
  language: string;
}

export async function extractProofFromZip(filePath: string): Promise<ProofFile> {
  const buffer = await readFile(filePath);
  const zip = await JSZip.loadAsync(buffer);

  const jsonFiles = Object.keys(zip.files).filter(
    (name) => name.endsWith('.json') && !zip.files[name]?.dir
  );

  if (jsonFiles.length === 0) {
    throw new Error('No JSON proof file found in ZIP');
  }

  const jsonFileName = jsonFiles[0]!;
  const jsonFile = zip.files[jsonFileName];

  if (!jsonFile) {
    throw new Error(`Cannot read file: ${jsonFileName}`);
  }

  const jsonContent = await jsonFile.async('string');

  try {
    const proof = JSON.parse(jsonContent) as ProofFile;

    if (!proof.proof || !proof.typingProofHash) {
      throw new Error('Invalid proof file structure');
    }

    return proof;
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${jsonFileName}: ${e.message}`);
    }
    throw e;
  }
}
