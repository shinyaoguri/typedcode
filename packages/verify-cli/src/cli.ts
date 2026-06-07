#!/usr/bin/env node
/**
 * @typedcode/verify-cli - Typing proof file verifier
 *
 * Usage: typedcode-verify <file.json|file.zip> [--mode <m>] [--exam-package <f>] [--submitted-at <ISO>]
 */

import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { verifyProof, type ProofFile } from './verify.js';
import { extractProofFromZip } from './zip.js';
import { formatResult, printError, printUsage } from './output.js';
import { Spinner } from './progress.js';
import {
  parseExamPackageManifest,
  type VerificationMode,
  type ExamPackageManifest,
} from '@typedcode/shared';

/** value を取る flag。`--name value` と `--name=value` の両方を許す。 */
const VALUE_FLAGS = new Set(['--mode', '--exam-package', '--submitted-at']);

function flagValue(args: string[], name: string): string | undefined {
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i === -1) return undefined;
  const arg = args[i]!;
  return arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : args[i + 1];
}

function parseModeFlag(args: string[]): VerificationMode {
  const value = flagValue(args, '--mode');
  if (value === undefined) return 'full';
  if (value === 'fast' || value === 'audit' || value === 'full') return value;
  throw new Error(`Invalid --mode value: ${value}. Use fast | audit | full.`);
}

function nonFlagArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (VALUE_FLAGS.has(arg)) {
      i++; // skip the flag's value
      continue;
    }
    if (arg.startsWith('--')) continue; // --flag=value or boolean flag
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
  if (positional.length === 0) {
    printError('No proof file given.');
    printUsage();
    process.exit(1);
  }
  const filePath = resolve(positional[0]!);
  const ext = extname(filePath).toLowerCase();

  // 試験モード (ADR-0006): 任意の問題パッケージ + 提出時刻
  const examPackagePath = flagValue(args, '--exam-package');
  const submittedAtRaw = flagValue(args, '--submitted-at');
  let submittedAtMs: number | undefined;
  if (submittedAtRaw !== undefined) {
    submittedAtMs = Date.parse(submittedAtRaw);
    if (Number.isNaN(submittedAtMs)) {
      printError(`Invalid --submitted-at value: ${submittedAtRaw}. Use an ISO 8601 timestamp.`);
      process.exit(1);
    }
  }

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

    // 問題パッケージ (.tcexam) の読込・パース (任意)
    let examPackageManifest: ExamPackageManifest | undefined;
    if (examPackagePath !== undefined) {
      const raw = await readFile(resolve(examPackagePath), 'utf-8');
      const parsed = parseExamPackageManifest(JSON.parse(raw));
      if (!parsed) {
        spinner.stop();
        printError(`Invalid exam package (.tcexam): ${examPackagePath}`);
        process.exit(1);
      }
      examPackageManifest = parsed;
    }

    spinner.stop();

    const result = await verifyProof(proofData, { mode, examPackageManifest, submittedAtMs });

    console.log(formatResult(result));

    process.exit(result.valid ? 0 : 1);
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
