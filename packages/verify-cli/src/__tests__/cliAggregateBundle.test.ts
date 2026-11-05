/**
 * `--aggregate-bundle` (ADR-0024 Tier S、#304) を実プロセスで確かめる。
 *
 * - 出力の JSON 文字列全体に、ファイル名・reflectionNotes・外部 analyzer の自由記述
 *   (analyzerId / summary / summaryParams / evidence.note / 契約外のフィールド / 未知の dimension) が
 *   1 つも出ない。各欄に `SECRET-*` を詰めて `SECRET` の不在で見る
 * - `--analysis-bundle` (Tier A) は従来どおり `filename` と `reflectionNotes` を含む (教員向けの既存用途)
 * - 両方の出力に「派生ビューで単独では検証できない」固定文言が入る
 * - CLI は入力の proof / ZIP を書き換えない (実行前後で sha256 が同じ)
 */

import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { DERIVED_VIEW_NOTICE } from '@typedcode/shared';
import { fixture, runSourceCli } from './helpers/runCli.js';

const VALID = fixture('proofs', 'valid.json');
const LEAKY_ANALYZER = fixture('analyzers', 'secret-leaky.mjs');

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tc-verify-cli-aggregate-'));
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** ファイル名に秘密を含む、有効 proof のコピー。 */
function secretNamedProof(): string {
  const path = join(tempDir(), 'SECRET-FILENAME_proof.json');
  copyFileSync(VALID, path);
  return path;
}

/**
 * 振り返りノート (`reflectionNote`) のイベントを末尾に足した proof。チェーンは壊れるが、
 * 分析とバンドルは検証の成否に関係なく出る (`integrityValid: false`)。
 */
function proofWithReflectionNote(): string {
  const proof = JSON.parse(readFileSync(VALID, 'utf-8')) as {
    proof: { events: Array<Record<string, unknown>> };
  };
  const last = proof.proof.events[proof.proof.events.length - 1]!;
  proof.proof.events.push({
    sequence: (last.sequence as number) + 1,
    timestamp: (last.timestamp as number) + 1000,
    type: 'reflectionNote',
    data: { text: 'SECRET-NOTE' },
  });
  const path = join(tempDir(), 'note_proof.json');
  writeFileSync(path, JSON.stringify(proof), 'utf-8');
  return path;
}

async function zipOf(proofPath: string): Promise<string> {
  const zip = new JSZip();
  zip.file('SECRET-ZIPENTRY_proof.json', readFileSync(proofPath, 'utf-8'));
  zip.file('valid.js', 'ok');
  const path = join(tempDir(), 'export.zip');
  writeFileSync(path, await zip.generateAsync({ type: 'uint8array' }));
  return path;
}

describe('--aggregate-bundle (Tier S, #304)', () => {
  it('writes no filename, reflection note or analyzer free text, while Tier A keeps them', async () => {
    const inputs = [secretNamedProof(), proofWithReflectionNote(), await zipOf(VALID)];
    const dir = tempDir();
    const aggregatePath = join(dir, 'aggregate.json');
    const tierAPath = join(dir, 'bundle.json');
    runSourceCli([
      ...inputs,
      '--analyzer',
      LEAKY_ANALYZER,
      '--aggregate-bundle',
      aggregatePath,
      '--analysis-bundle',
      tierAPath,
    ]);

    const aggregateJson = readFileSync(aggregatePath, 'utf-8');
    const aggregate = JSON.parse(aggregateJson) as Array<Record<string, unknown>>;
    expect(aggregate).toHaveLength(3);
    expect(aggregateJson).not.toContain('SECRET');
    for (const key of [
      'filename',
      'reflectionNotes',
      'moments',
      'fromEventIndex',
      'fingerprint',
      'events',
      'content',
    ]) {
      expect(aggregateJson).not.toContain(`"${key}"`);
    }

    // 同じ実行の Tier A には秘密が載っている (= 上の不在は入力に秘密が無かったからではない)。
    const tierAJson = readFileSync(tierAPath, 'utf-8');
    const tierA = JSON.parse(tierAJson) as Array<{ filename: string; processSummary: { reflectionNotes: string[] } }>;
    expect(tierA.map((b) => b.filename)).toEqual([inputs[0], inputs[1], `${inputs[2]}:SECRET-ZIPENTRY_proof.json`]);
    expect(tierA[1]!.processSummary.reflectionNotes).toEqual(['SECRET-NOTE']);
    expect(tierAJson).toContain('SECRET-SUMMARY');
  });

  it('puts the fixed derived-view notice in both outputs', () => {
    const dir = tempDir();
    const aggregatePath = join(dir, 'aggregate.json');
    const tierAPath = join(dir, 'bundle.json');
    const res = runSourceCli([VALID, '--aggregate-bundle', aggregatePath, '--analysis-bundle', tierAPath]);
    expect(res.exitCode).toBe(0);
    for (const path of [aggregatePath, tierAPath]) {
      const [entry] = JSON.parse(readFileSync(path, 'utf-8')) as Array<{ notice: string }>;
      expect(entry!.notice).toBe(DERIVED_VIEW_NOTICE);
    }
    const [agg] = JSON.parse(readFileSync(aggregatePath, 'utf-8')) as Array<{
      schema: string;
      integrityValid: boolean;
    }>;
    expect(agg!.schema).toBe('aggregate-bundle/1');
    expect(agg!.integrityValid).toBe(true);
  });

  it('leaves the input proof and ZIP byte-for-byte unchanged', async () => {
    const json = secretNamedProof();
    const zip = await zipOf(VALID);
    const before = [sha256(json), sha256(zip)];
    const dir = tempDir();
    const res = runSourceCli([
      json,
      zip,
      '--aggregate-bundle',
      join(dir, 'aggregate.json'),
      '--analysis-bundle',
      join(dir, 'bundle.json'),
    ]);
    expect(res.exitCode).toBe(0);
    expect([sha256(json), sha256(zip)]).toEqual(before);
  });
});
