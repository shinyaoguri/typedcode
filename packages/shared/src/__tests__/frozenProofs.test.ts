/**
 * 凍結 proof の互換検査 (#581)。
 *
 * `fixtures/frozen-proofs/` の proof は一度だけ生成してコミットしたもので、**作り直さない**
 * (fixtures/frozen-proofs/README.md)。記録側と検証側は同じ shared の関数 (deterministicStringify /
 * computeAnchoredChainRoot / hashSignedCheckpointPayload / computeExamChainRoot) を使うので、両側を同時に
 * 変えるとユニットはすべて緑のまま、出回っている proof だけが検証できなくなる。ここではその「出回っている
 * proof」の代表を現行の検証器で full モード (PoSW を全件再計算) に通し、結論を固定する。
 *
 * **このテストが落ちたら、fixture ではなく検証器側が既存の proof を壊している。** fixture を作り直して
 * 緑に戻してはいけない (shared/AGENTS.md 不変条件 1・4・7)。
 *
 * テスト鍵は registry を注入して使う (本番 registry には載せない)。full モードの検証は数秒かかるので、
 * fixture ごとに 1 回だけ検証して各ケースで結論を 1 つずつ確かめる。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  deriveAssurance,
  parseExamPackageManifest,
  verifyExamBinding,
  verifyProofFile,
  type AssuranceInput,
  type AssuranceResult,
  type CheckpointPublicKey,
  type ExamAuthorityKey,
  type ExamBindingVerificationResult,
  type ExamPackageManifest,
  type FullVerificationResult,
  type ProofFile,
} from '../index.js';

// happy-dom の URL は file: を扱えないので、パスは node:path で組み立てる
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'frozen-proofs');

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf-8')) as T;
}

/** full モードは PoSW (10,000 回 × イベント数) を再計算する。カバレッジ計測下でも収まる余裕をとる */
const FULL_VERIFY_TIMEOUT_MS = 120_000;

const checkpointRegistry: readonly CheckpointPublicKey[] = [loadFixture<CheckpointPublicKey>('checkpoint-key.json')];
const examAuthorityRegistry: readonly ExamAuthorityKey[] = [loadFixture<ExamAuthorityKey>('exam-authority-key.json')];

/** verify-cli `verify.ts` の `deriveAssurance` 呼び出しと同じ写像 (分析・スクショは省く)。 */
function assuranceOf(result: FullVerificationResult, binding?: ExamBindingVerificationResult): AssuranceResult {
  const input: AssuranceInput = {
    metadataValid: result.metadataValid,
    chainValid: result.chainValid,
    exam: binding ? { present: true, packageProvided: true, bindingValid: binding.valid } : undefined,
    rootAnchored: result.rootAnchored ?? false,
    signedCheckpoints: result.signedCheckpoints
      ? {
          anchored: result.signedCheckpoints.anchored,
          valid: result.signedCheckpoints.valid,
          sparse: result.signedCheckpoints.density?.sparse,
          postHocSuspected: result.signedCheckpoints.temporal?.postHocSuspected,
          terminal: result.signedCheckpoints.coverage.terminalAnchored,
        }
      : undefined,
    sessionTokenMismatch: result.sessionTokenMismatch ?? false,
    isPureTyping: result.isPureTyping,
    poswSkipped: result.poswSkipped ?? false,
  };
  return deriveAssurance(input);
}

describe('frozen casual proof anchored by a session start token and signed checkpoints', () => {
  let result: FullVerificationResult;

  beforeAll(async () => {
    const proof = loadFixture<ProofFile>('casual-anchored.proof.json');
    result = await verifyProofFile(proof, undefined, {
      mode: 'full',
      signedCheckpointKeyRegistry: checkpointRegistry,
    });
  }, FULL_VERIFY_TIMEOUT_MS);

  it('still verifies as valid with every PoSW recomputed', () => {
    expect(result.valid).toBe(true);
  });

  it('still passes the integrity checks before any acceptance policy', () => {
    expect(result.integrityValid).toBe(true);
  });

  it('still recomputes the root from the server nonce of the bundled token', () => {
    expect(result.rootAnchored).toBe(true);
  });

  it('still verifies all three signed checkpoints against the fixture key', () => {
    expect(result.signedCheckpoints?.valid).toBe(true);
    expect(result.signedCheckpoints?.details.map((d) => d.valid)).toEqual([true, true, true]);
  });

  it('still reports the external paste as not pure typing', () => {
    expect(result.isPureTyping).toBe(false);
  });

  it('still derives an anchored temporal level', () => {
    expect(assuranceOf(result).temporal).toBe('anchored');
  });

  it(
    'still verifies as valid under every opt-in acceptance policy',
    async () => {
      const proof = loadFixture<ProofFile>('casual-anchored.proof.json');
      const strict = await verifyProofFile(proof, undefined, {
        mode: 'full',
        signedCheckpointKeyRegistry: checkpointRegistry,
        requireRootAnchor: true,
        requireAnchorDensity: true,
        requireSignedCheckpoints: true,
        requireTerminalAnchor: true,
      });
      // 整合性が落ちると policy は評価されず violations は空のままになるので、violations ではなく valid で見る
      expect(strict.valid).toBe(true);
    },
    FULL_VERIFY_TIMEOUT_MS
  );
});

describe.each([
  { name: 'exam v1 (single problem)', fixture: 'exam-v1', problemId: 'p1', signedCheckpoints: 0 },
  { name: 'exam v2 (bundle, per-problem root binding)', fixture: 'exam-v2', problemId: 'p1', signedCheckpoints: 2 },
])('frozen $name proof', ({ fixture, problemId, signedCheckpoints }) => {
  let manifest: ExamPackageManifest;
  let binding: ExamBindingVerificationResult;
  let result: FullVerificationResult;

  beforeAll(async () => {
    const proof = loadFixture<ProofFile>(`${fixture}.proof.json`);
    const parsed = parseExamPackageManifest(loadFixture<unknown>(`${fixture}.tcexam.json`));
    if (!parsed) throw new Error(`${fixture}.tcexam.json no longer parses as an exam package`);
    manifest = parsed;
    binding = await verifyExamBinding(proof, manifest, { examAuthorityRegistry });
    result = await verifyProofFile(proof, undefined, {
      mode: 'full',
      signedCheckpointKeyRegistry: checkpointRegistry,
      examBindingVerified: binding.valid,
    });
  }, FULL_VERIFY_TIMEOUT_MS);

  it('still binds the proof to its sealed package', () => {
    expect(binding.valid).toBe(true);
  });

  it('still reports the verified identifiers from the signed package', () => {
    expect(binding.verifiedIds).toEqual({ examId: manifest.examId, problemId, variant: null });
  });

  it('still verifies as valid with every PoSW recomputed', () => {
    expect(result.valid).toBe(true);
  });

  it('still passes the integrity checks before any acceptance policy', () => {
    expect(result.integrityValid).toBe(true);
  });

  it('still recomputes the exam root without claiming a server anchor', () => {
    expect({ rootValid: result.rootValid, rootAnchored: result.rootAnchored }).toEqual({
      rootValid: true,
      rootAnchored: false,
    });
  });

  it('still verifies the expected number of signed checkpoints', () => {
    expect(result.signedCheckpoints?.details.filter((d) => d.valid)).toHaveLength(signedCheckpoints);
    expect(result.signedCheckpoints?.anchored).toBe(signedCheckpoints > 0);
  });

  it('still derives the exam-t0 temporal level from the verified binding', () => {
    expect(assuranceOf(result, binding).temporal).toBe('exam-t0');
  });
});
