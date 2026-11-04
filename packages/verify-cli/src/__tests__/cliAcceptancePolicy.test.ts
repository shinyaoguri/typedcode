/**
 * 受理ポリシーのフラグ (#296) を実プロセスの終了コードと出力で固定する。
 *
 * - `--require-signed-checkpoints`: 署名 cp が 0 件の proof を exit 1 にし、`signed-checkpoints-missing` を出す
 * - `--require-final-anchor`: 最終イベントまで署名が届いていない proof を exit 1 にし、未署名の件数を出す
 * - 違反した proof を含む複数入力でも、残りの入力の検証と `--analysis-json` / `--analysis-bundle` を続ける
 *
 * 子プロセスの CLI は既定の registry しか使わず、テスト鍵を注入できない。そこで「要件を満たす proof」には
 * イベントが 0 件の proof を使う (未署名の末尾が無いので最終署名の要件の対象外)。最終イベントまで署名済みの
 * proof が受理されることは、registry を注入できる verify の `webCliParity.test.ts` と shared の
 * `acceptancePolicy.test.ts` が見る。
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { TypingProof, computeHash, type FingerprintComponents } from '@typedcode/shared';
import { fixture, runSourceCli } from './helpers/runCli.js';

/** 署名 cp が 0 件・イベント 2 件の有効な proof (未署名の末尾 2 件)。 */
const NO_SIGNED_CHECKPOINTS = fixture('proofs', 'valid.json');

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tc-verify-cli-policy-'));
}

/** 固定値の PoSW を返す Worker スタブ。イベント 0 件の proof では呼ばれない。 */
class PoswWorkerStub {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage(): void {}
  terminate(): void {}
}

const components: FingerprintComponents = {
  userAgent: 'TypedCode verify-cli acceptance policy test',
  language: 'en',
  languages: ['en'],
  platform: 'FixtureOS',
  hardwareConcurrency: 4,
  deviceMemory: 8,
  screen: { width: 1, height: 1, availWidth: 1, availHeight: 1, colorDepth: 24, pixelDepth: 24, devicePixelRatio: 1 },
  timezone: 'UTC',
  timezoneOffset: 0,
  canvas: 'fixture',
  webgl: { vendor: 'fixture', renderer: 'fixture' },
  fonts: ['Arial'],
  cookieEnabled: true,
  doNotTrack: 'unspecified',
  maxTouchPoints: 0,
};

/** イベントが 0 件の有効な proof を一時ファイルに書く (最終署名の要件の対象外)。 */
async function writeEmptyProof(): Promise<string> {
  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const proof = new TypingProof();
  await proof.initialize(fingerprintHash, components, new PoswWorkerStub() as unknown as Worker);
  const exported = await proof.exportProof('');
  const path = join(tempDir(), 'empty_proof.json');
  writeFileSync(path, JSON.stringify({ ...exported, content: '', language: 'javascript' }), 'utf-8');
  return path;
}

let emptyProof: string;

beforeAll(async () => {
  emptyProof = await writeEmptyProof();
});

describe('--require-signed-checkpoints (#296)', () => {
  it('exits 1 and names signed-checkpoints-missing for a proof without signed checkpoints', () => {
    const res = runSourceCli([NO_SIGNED_CHECKPOINTS, '--require-signed-checkpoints']);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('FAIL signed-checkpoints-missing:');
  });

  it('keeps the integrity checks passing while the policy fails', () => {
    const res = runSourceCli([NO_SIGNED_CHECKPOINTS, '--require-signed-checkpoints']);

    expect(res.stdout).toMatch(/^Hash Chain: {2}PASS$/m);
    expect(res.stdout).toMatch(/^Metadata: {4}PASS$/m);
  });

  it('exits 0 for the same proof without the flag and prints no policy section', () => {
    const res = runSourceCli([NO_SIGNED_CHECKPOINTS]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain('Acceptance policy');
  });
});

describe('--require-final-anchor (#296)', () => {
  it('exits 1 and reports the unsigned trailing events', () => {
    const res = runSourceCli([NO_SIGNED_CHECKPOINTS, '--require-final-anchor']);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toMatch(/^ {2}FAIL terminal-anchor-missing: .+ \(2 unsigned trailing events\)$/m);
  });

  it('exits 0 for a proof with no unsigned tail', () => {
    const res = runSourceCli([emptyProof, '--require-final-anchor']);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/^Result: +all requirements met$/m);
  });

  it('keeps verifying the other inputs and writes both analysis outputs when one input violates the policy', () => {
    const dir = tempDir();
    const json = join(dir, 'analysis.json');
    const bundle = join(dir, 'bundle.json');
    const res = runSourceCli([
      NO_SIGNED_CHECKPOINTS,
      emptyProof,
      '--require-final-anchor',
      '--analysis-json',
      json,
      '--analysis-bundle',
      bundle,
    ]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('=== Summary: 1/2 proofs passed ===');
    expect(res.stdout).toContain(`✓ ${emptyProof}`);

    const analysis = JSON.parse(readFileSync(json, 'utf-8')) as Array<{
      filename: string;
      valid: boolean;
      policy: { violations: Array<{ code: string; unsignedTailEvents?: number }> };
    }>;
    expect(analysis.map((e) => [e.filename, e.valid])).toEqual([
      [NO_SIGNED_CHECKPOINTS, false],
      [emptyProof, true],
    ]);
    expect(analysis[0]!.policy.violations).toEqual([
      expect.objectContaining({ code: 'terminal-anchor-missing', unsignedTailEvents: 2 }),
    ]);
    expect(analysis[1]!.policy.violations).toEqual([]);

    const bundles = JSON.parse(readFileSync(bundle, 'utf-8')) as Array<Record<string, unknown>>;
    expect(bundles.map((e) => e.filename)).toEqual([NO_SIGNED_CHECKPOINTS, emptyProof]);
    // ADR-0024 の content-free 派生物は形を変えない (policy は --analysis-json にだけ足す)。
    expect(bundles.every((e) => !('policy' in e))).toBe(true);
  });
});
