#!/usr/bin/env node
/**
 * @typedcode/verify-cli - Typing proof file verifier
 *
 * Usage: typedcode-verify <file.json|file.zip>
 */

import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { verifyProof, type ProofFile } from './verify.js';
import { extractProofFromZip } from './zip.js';
import { formatResult, printError, printUsage } from './output.js';
import { Spinner } from './progress.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const filePath = resolve(args[0]!);
  const ext = extname(filePath).toLowerCase();

  try {
    const spinner = new Spinner('Loading proof file...');
    spinner.start();

    let proofData: ProofFile;

    if (ext === '.zip') {
      proofData = await extractProofFromZip(filePath);
    } else if (ext === '.json') {
      const content = await readFile(filePath, 'utf-8');
      proofData = JSON.parse(content) as ProofFile;

      if (!proofData.proof || !proofData.typingProofHash) {
        throw new Error('Invalid proof file structure');
      }
    } else {
      spinner.stop();
      printError(`Unsupported file type: ${ext}. Use .json or .zip`);
      process.exit(1);
    }

    spinner.stop();

    const result = await verifyProof(proofData);

    console.log(formatResult(result));

    process.exit(result.valid ? 0 : 1);
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
