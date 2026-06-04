#!/usr/bin/env node
/**
 * Documentation drift checker.
 *
 * Layer 1 (cf. ADR / docs runbook): grep-based check that numeric / version
 * facts in the source of truth (TypeScript) match the values mentioned in
 * docs (CLAUDE.md / README.md / system-spec.md).
 *
 * 設計判断: 完全な TS パースは過剰なので、各 "source of truth" は
 * 限定的な正規表現で十分。挙動の変化 (= 意味の変化) は別途人間 + AI が
 * 拾う (Layer 2 / 3 / 4)。
 *
 * 失敗時は exit 1。CI に組み込んで PR で red にする想定。
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

async function read(rel) {
  return await readFile(resolve(REPO_ROOT, rel), 'utf-8');
}

/** Count entries in a `const NAME = [ 'a', 'b', ... ]` array literal. */
function countConstStringArray(source, name) {
  const re = new RegExp(`const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`);
  const m = source.match(re);
  if (!m) throw new Error(`Could not locate const ${name}`);
  return (m[1].match(/'[^']+'/g) ?? []).length;
}

/** Count entries in a `new Set([ 'a', 'b', ... ])` literal assigned to NAME. */
function countConstStringSet(source, name) {
  const re = new RegExp(`const ${name}[^=]*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`);
  const m = source.match(re);
  if (!m) throw new Error(`Could not locate set ${name}`);
  return (m[1].match(/'[^']+'/g) ?? []).length;
}

/** Extract a numeric/string const value: `export const NAME = VALUE;`. */
function extractConst(source, name) {
  const re = new RegExp(`export const ${name}\\s*=\\s*([^;]+);`);
  const m = source.match(re);
  if (!m) throw new Error(`Could not extract const ${name}`);
  return m[1].trim().replace(/_/g, '').replace(/ as const$/, '');
}

/** Run a check: every (file, regex) pair must match `expected` exactly. */
async function expectInDocs(label, expected, locations) {
  const failures = [];
  for (const { file, regex, group = 1, normalize } of locations) {
    let text;
    try {
      text = await read(file);
    } catch (err) {
      failures.push({ file, reason: `read failed: ${err.message}` });
      continue;
    }
    const matches = [...text.matchAll(regex)];
    if (matches.length === 0) {
      failures.push({ file, reason: `pattern not found: ${regex}` });
      continue;
    }
    for (const m of matches) {
      const raw = m[group];
      const found = normalize ? normalize(raw) : raw;
      if (String(found) !== String(expected)) {
        const lineNo = text.slice(0, m.index).split('\n').length;
        failures.push({
          file: `${file}:${lineNo}`,
          reason: `expected "${expected}" but found "${found}"${normalize ? ` (raw: "${raw}")` : ''} in match: ${m[0].slice(0, 80)}`,
        });
      }
    }
  }
  return { label, expected, failures };
}

async function main() {
  console.log(`${DIM}Reading sources of truth from packages/shared/src/...${RESET}`);

  const validatorTs = await read('packages/shared/src/typingProof/InputTypeValidator.ts');
  const versionTs = await read('packages/shared/src/version.ts');
  const checkpointMgrTs = await read('packages/shared/src/typingProof/CheckpointManager.ts');

  const eventTypeCount = countConstStringSet(validatorTs, 'VALID_EVENT_TYPES');
  const inputTypeTotal = countConstStringSet(validatorTs, 'VALID_INPUT_TYPES');
  const allowedCount = countConstStringArray(validatorTs, 'ALLOWED_INPUT_TYPES');
  const blockedCount = countConstStringArray(validatorTs, 'PROHIBITED_INPUT_TYPES');
  const otherCount = inputTypeTotal - allowedCount - blockedCount;
  const poswIterations = Number(extractConst(versionTs, 'POSW_ITERATIONS'));
  const proofFormatVersion = extractConst(versionTs, 'PROOF_FORMAT_VERSION').replace(/['"]/g, '');
  const defaultMaxEvents = Number(extractConst(checkpointMgrTs, 'DEFAULT_MAX_EVENTS_PER_CHECKPOINT'));
  const defaultMaxIntervalMs = Number(extractConst(checkpointMgrTs, 'DEFAULT_MAX_CHECKPOINT_INTERVAL_MS'));

  console.log(`${DIM}Source-of-truth values:${RESET}`);
  console.log(`  EventType count:                       ${eventTypeCount}`);
  console.log(`  InputType total / allowed / blocked / other: ${inputTypeTotal} / ${allowedCount} / ${blockedCount} / ${otherCount}`);
  console.log(`  POSW_ITERATIONS:                       ${poswIterations}`);
  console.log(`  PROOF_FORMAT_VERSION:                  ${proofFormatVersion}`);
  console.log(`  DEFAULT_MAX_EVENTS_PER_CHECKPOINT:     ${defaultMaxEvents}`);
  console.log(`  DEFAULT_MAX_CHECKPOINT_INTERVAL_MS:    ${defaultMaxIntervalMs}`);
  console.log('');

  const results = [];

  // ---- EventType count ----
  results.push(
    await expectInDocs('EventType count', eventTypeCount, [
      { file: 'README.md', regex: /\*\*(\d+)\s*種類のイベント\*\*/g },
      { file: 'README.md', regex: /###\s*イベントタイプ\s*\((\d+)\s*種\)/g },
      { file: 'packages/shared/README.md', regex: /###\s*EventType\s*\((\d+)\s*種類\)/g },
      { file: 'packages/editor/README.md', regex: /\*\*(\d+)\s*種類のイベント\*\*/g },
      { file: 'docs/system-spec.md', regex: /(\d+)\s*種類のイベントタイプがある/g },
      { file: 'docs/system-spec.md', regex: /上記\s*(\d+)\s*種類/g },
    ])
  );

  // ---- InputType total ----
  results.push(
    await expectInDocs('InputType total', inputTypeTotal, [
      { file: 'packages/shared/README.md', regex: /###\s*InputType\s*\((\d+)\s*種類\)/g },
      { file: 'docs/system-spec.md', regex: /InputType\s*\|\s*null;\s*\/\/[^\n]*?(\d+)\s*種/g },
    ])
  );

  // ---- InputType allowed ----
  results.push(
    await expectInDocs('InputType allowed count', allowedCount, [
      { file: 'packages/shared/README.md', regex: /\/\/\s*許可される入力タイプ\s*\((\d+)\s*種類\)/g },
    ])
  );

  // ---- InputType blocked ----
  results.push(
    await expectInDocs('InputType blocked count', blockedCount, [
      { file: 'packages/shared/README.md', regex: /\/\/\s*外部入力\s*\(禁止、\s*(\d+)\s*種類\)/g },
    ])
  );

  // ---- POSW_ITERATIONS ----
  results.push(
    await expectInDocs('POSW_ITERATIONS', poswIterations, [
      { file: 'packages/shared/README.md', regex: /POSW_ITERATIONS\s*=\s*(\d+)/g },
      { file: 'docs/system-spec.md', regex: /\|\s*`POSW_ITERATIONS`\s*\|\s*(\d+)\s*\|/g },
      { file: 'docs/system-spec.md', regex: /必ず\s*(\d+)\s*\(POSW_ITERATIONS/g },
    ])
  );

  // ---- PROOF_FORMAT_VERSION ----
  results.push(
    await expectInDocs('PROOF_FORMAT_VERSION', proofFormatVersion, [
      { file: 'packages/shared/README.md', regex: /PROOF_FORMAT_VERSION\s*=\s*'([^']+)'/g },
      { file: 'docs/system-spec.md', regex: /\|\s*`PROOF_FORMAT_VERSION`\s*\|\s*'([^']+)'/g },
    ])
  );

  // ---- Hybrid cp trigger: events default ----
  results.push(
    await expectInDocs('DEFAULT_MAX_EVENTS_PER_CHECKPOINT', defaultMaxEvents, [
      { file: 'packages/shared/README.md', regex: /DEFAULT_MAX_EVENTS_PER_CHECKPOINT\s*=\s*(\d+)/g },
      { file: 'docs/system-spec.md', regex: /\*\*(\d+)\s*イベント\*\*\s*が経過\s*\(`DEFAULT_MAX_EVENTS_PER_CHECKPOINT`/g },
      { file: 'docs/system-spec.md', regex: /\|\s*`DEFAULT_MAX_EVENTS_PER_CHECKPOINT`\s*\|\s*(\d+)\s*\|/g },
    ])
  );

  // ---- Hybrid cp trigger: interval ms default ----
  // Note: docs typically write `10_000` (underscored) for readability.
  results.push(
    await expectInDocs('DEFAULT_MAX_CHECKPOINT_INTERVAL_MS', defaultMaxIntervalMs, [
      { file: 'packages/shared/README.md', regex: /DEFAULT_MAX_CHECKPOINT_INTERVAL_MS\s*=\s*([\d_]+)/g, normalize: (s) => Number(s.replace(/_/g, '')) },
      { file: 'docs/system-spec.md', regex: /\|\s*`DEFAULT_MAX_CHECKPOINT_INTERVAL_MS`\s*\|\s*([\d_]+)\s*\|/g, normalize: (s) => Number(s.replace(/_/g, '')) },
    ])
  );

  // ---- Node version consistency ----
  const nodeVersionFile = (await read('.node-version')).trim();
  const rootPkg = JSON.parse(await read('package.json'));
  const cliPkg = JSON.parse(await read('packages/verify-cli/package.json'));
  const deployYml = await read('.github/workflows/deploy.yml');
  const majorNodeFromFile = nodeVersionFile.split('.')[0];
  const rootEngines = rootPkg.engines?.node ?? '';
  const cliEngines = cliPkg.engines?.node ?? '';
  const deployMatch = deployYml.match(/node-version:\s*'(\d+)'/);
  const deployVersion = deployMatch?.[1];

  const nodeFailures = [];
  if (!rootEngines.includes(majorNodeFromFile)) {
    nodeFailures.push({ file: 'package.json', reason: `engines.node = "${rootEngines}" but .node-version major is ${majorNodeFromFile}` });
  }
  if (!cliEngines.includes(majorNodeFromFile)) {
    nodeFailures.push({ file: 'packages/verify-cli/package.json', reason: `engines.node = "${cliEngines}" but .node-version major is ${majorNodeFromFile}` });
  }
  if (deployVersion !== majorNodeFromFile) {
    nodeFailures.push({ file: '.github/workflows/deploy.yml', reason: `node-version = "${deployVersion}" but .node-version major is ${majorNodeFromFile}` });
  }
  results.push({ label: `Node version (= ${majorNodeFromFile})`, expected: majorNodeFromFile, failures: nodeFailures });

  // ---- Report ----
  console.log(`${DIM}Results:${RESET}`);
  let hadFailure = false;
  for (const r of results) {
    if (r.failures.length === 0) {
      console.log(`  ${GREEN}OK${RESET}    ${r.label} = ${r.expected}`);
    } else {
      hadFailure = true;
      console.log(`  ${RED}DRIFT${RESET} ${r.label} = ${r.expected}`);
      for (const f of r.failures) {
        console.log(`        ${YELLOW}- ${f.file}${RESET}: ${f.reason}`);
      }
    }
  }

  console.log('');
  if (hadFailure) {
    console.log(`${RED}Documentation drift detected.${RESET} Update the docs above, then re-run \`npm run check-docs\`.`);
    process.exit(1);
  } else {
    console.log(`${GREEN}No documentation drift detected.${RESET}`);
  }
}

main().catch((err) => {
  console.error(`${RED}check-doc-drift failed:${RESET}`, err);
  process.exit(2);
});
