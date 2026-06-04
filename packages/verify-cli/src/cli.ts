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
import type { VerificationMode } from '@typedcode/shared';

function parseModeFlag(args: string[]): VerificationMode {
  const modeIndex = args.findIndex((a) => a === '--mode' || a.startsWith('--mode='));
  if (modeIndex === -1) return 'full';
  const arg = args[modeIndex]!;
  const value = arg.startsWith('--mode=') ? arg.slice('--mode='.length) : args[modeIndex + 1];
  if (value === 'fast' || value === 'audit' || value === 'full') return value;
  throw new Error(`Invalid --mode value: ${value}. Use fast | audit | full.`);
}

function nonFlagArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--mode') {
      i++; // skip value
      continue;
    }
    if (arg.startsWith('--')) continue;
    out.push(arg);
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const mode = parseModeFlag(args);
  const positional = nonFlagArgs(args);
  const filePath = resolve(positional[0]!);
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

    const result = await verifyProof(proofData, { mode });

    console.log(formatResult(result));

    process.exit(result.valid ? 0 : 1);
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
