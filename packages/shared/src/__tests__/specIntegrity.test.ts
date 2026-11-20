/**
 * 仕様別の入口の整合性 (`integrity`) を `checks` だけから導く規則を固定する (#809)。
 *
 * - どれかの検査が `fail` → `failed`、`fail` が無くどれかが `not-checked` → `partial`、それ以外 → `proven`
 * - 鍵を信頼できない失敗・token の検証失敗・sessionId の不一致も `failed`
 * - legacy の `verifyProofFile` が `integrityValid: false` にする proof に、`proven` / `partial` を返さない
 *   (下の突き合わせ。新しい入口は legacy より甘くならない)
 */

import { describe, expect, it } from 'vitest';
import {
  computeHash,
  verifyProofBySpec,
  type CheckpointPublicKey,
  type ExamAuthorityKey,
  type ProofFile,
  type SpecVerificationContext,
  type SpecVerificationResult,
} from '../index.js';
import {
  FULL_VERIFY_TIMEOUT_MS,
  frozenCheckpointKey,
  frozenContext,
  frozenExamAuthorityKey,
  loadFrozenExamPackage,
  loadFrozenProof,
} from './fixtures/frozenProofFixtures.js';

type Fixture = 'casual-anchored' | 'exam-v1' | 'exam-v2';

function flipLastHex(hex: string): string {
  return hex.slice(0, -1) + (hex.at(-1) === '0' ? '1' : '0');
}

function withKeys(
  context: SpecVerificationContext,
  keys: { checkpointKeys?: CheckpointPublicKey[]; examAuthorityKeys?: ExamAuthorityKey[] }
): SpecVerificationContext {
  return { ...context, trust: { ...context.trust, ...keys } };
}

/** casual の token だけを持ち、署名 cp を持たない proof (token の検査だけを切り出す) */
function tokenOnly(edit: (proof: ProofFile) => void = () => {}): ProofFile {
  const proof = loadFrozenProof('casual-anchored');
  for (const cp of proof.checkpoints ?? []) delete cp.signature;
  edit(proof);
  return proof;
}

/** exam-v2 (署名 cp あり) に casual の token を同梱する (sessionId が食い違う) */
function examWithForeignToken(): ProofFile {
  const proof = loadFrozenProof('exam-v2');
  proof.sessionStartToken = loadFrozenProof('casual-anchored').sessionStartToken;
  return proof;
}

describe('verifyProofBySpec integrity derived from the checks', () => {
  it(
    'is proven when every check passes or does not apply',
    async () => {
      const result = await verifyProofBySpec(loadFrozenProof('casual-anchored'), frozenContext());
      expect(result.integrity).toBe('proven');
    },
    FULL_VERIFY_TIMEOUT_MS
  );

  it('is partial in fast mode because PoSW is not checked', async () => {
    const result = await verifyProofBySpec(loadFrozenProof('casual-anchored'), frozenContext({ mode: 'fast' }));
    expect(result.integrity).toBe('partial');
  });

  it(
    'is partial for an exam proof whose problem package was not provided',
    async () => {
      const result = await verifyProofBySpec(loadFrozenProof('exam-v2'), frozenContext());
      expect(result.integrity).toBe('partial');
    },
    FULL_VERIFY_TIMEOUT_MS
  );

  it(
    'is failed when signed checkpoints are signed by an untrusted key',
    async () => {
      const result = await verifyProofBySpec(
        loadFrozenProof('exam-v2'),
        withKeys(frozenContext({ examPackage: loadFrozenExamPackage('exam-v2') }), { checkpointKeys: [] })
      );
      expect([result.checks.signedCheckpoints.code, result.integrity]).toEqual([
        'signed-checkpoint-key-untrusted',
        'failed',
      ]);
    },
    FULL_VERIFY_TIMEOUT_MS
  );

  it('is failed when only the session token is signed by an unknown key', async () => {
    const result = await verifyProofBySpec(
      tokenOnly(),
      withKeys(frozenContext({ mode: 'fast' }), { checkpointKeys: [] })
    );
    expect([result.checks.sessionAnchor.code, result.integrity]).toEqual(['token-unknown-key', 'failed']);
  });

  it('is failed when the session token does not verify', async () => {
    const proof = tokenOnly((p) => {
      p.sessionStartToken!.payload.turnstileVerified = !p.sessionStartToken!.payload.turnstileVerified;
    });
    const result = await verifyProofBySpec(proof, frozenContext({ mode: 'fast' }));
    expect([result.checks.sessionAnchor.code, result.integrity]).toEqual(['token-invalid', 'failed']);
  });

  it('is failed when the bundled token and the signed checkpoints belong to different sessions', async () => {
    const result = await verifyProofBySpec(
      examWithForeignToken(),
      frozenContext({ mode: 'fast', examPackage: loadFrozenExamPackage('exam-v2') })
    );
    expect([result.checks.sessionAnchor.code, result.integrity]).toEqual(['token-session-mismatch', 'failed']);
  });

  it('is failed when the exam authority key is untrusted', async () => {
    const result = await verifyProofBySpec(
      loadFrozenProof('exam-v1'),
      withKeys(frozenContext({ mode: 'fast', examPackage: loadFrozenExamPackage('exam-v1') }), {
        examAuthorityKeys: [],
      })
    );
    expect([result.checks.problemBinding.code, result.integrity]).toEqual(['exam-authority-key-untrusted', 'failed']);
  });

  it('is failed rather than partial when a failure and a skipped check coexist', async () => {
    const proof = loadFrozenProof('casual-anchored');
    proof.content += ' ';
    const result = await verifyProofBySpec(proof, frozenContext({ mode: 'fast' }));
    expect(result.integrity).toBe('failed');
  });
});

/** 突き合わせる変種: proof の作り方と context */
interface Variant {
  name: string;
  fixture: Fixture;
  edit?: (proof: ProofFile) => void | Promise<void>;
  context?: (base: SpecVerificationContext) => SpecVerificationContext;
  withPackage?: boolean;
}

const revoked = (revokedAt?: string) => ({ status: 'revoked' as const, ...(revokedAt ? { revokedAt } : {}) });
const KEY_VARIANTS: Array<{ label: string; entry: Record<string, unknown> }> = [
  { label: 'revoked after the anchors', entry: revoked('2027-01-01T00:00:00.000Z') },
  { label: 'revoked before the anchors', entry: revoked('2026-01-02T00:00:00.000Z') },
  { label: 'revoked without revokedAt', entry: revoked() },
  { label: 'expired', entry: { validUntil: '2026-01-02T00:00:00.000Z' } },
  { label: 'expired between the checkpoints', entry: { validUntil: '2026-11-04T16:01:05.000Z' } },
  { label: 'not yet valid', entry: { validFrom: '2027-01-01T00:00:00.000Z' } },
  { label: 'a malformed date', entry: { validFrom: 'not a date' } },
];

const VARIANTS: Variant[] = [
  ...(['casual-anchored', 'exam-v1', 'exam-v2'] as const).map((fixture) => ({
    name: `${fixture} as frozen`,
    fixture,
    withPackage: true,
  })),
  { name: 'exam-v1 without its package', fixture: 'exam-v1' },
  { name: 'exam-v2 without its package', fixture: 'exam-v2' },
  {
    name: 'exam-v1 with the package of exam-v2',
    fixture: 'exam-v1',
    context: (c) => ({ ...c, examPackage: loadFrozenExamPackage('exam-v2') }),
  },
  { name: 'exam-v1 with an unreadable package', fixture: 'exam-v1', context: (c) => ({ ...c, examPackage: {} }) },
  {
    name: 'exam-v2 with an empty authority registry',
    fixture: 'exam-v2',
    withPackage: true,
    context: (c) => withKeys(c, { examAuthorityKeys: [] }),
  },
  {
    name: 'exam-v2 with an empty checkpoint registry',
    fixture: 'exam-v2',
    withPackage: true,
    context: (c) => withKeys(c, { checkpointKeys: [] }),
  },
  {
    name: 'exam-v1 with a foreign session token',
    fixture: 'exam-v1',
    withPackage: true,
    edit: (p) => {
      p.sessionStartToken = loadFrozenProof('casual-anchored').sessionStartToken;
    },
  },
  {
    name: 'exam-v2 with a foreign session token',
    fixture: 'exam-v2',
    withPackage: true,
    edit: (p) => {
      p.sessionStartToken = loadFrozenProof('casual-anchored').sessionStartToken;
    },
  },
  {
    name: 'casual with an empty checkpoint registry',
    fixture: 'casual-anchored',
    context: (c) => withKeys(c, { checkpointKeys: [] }),
  },
  ...KEY_VARIANTS.map(({ label, entry }) => ({
    name: `casual with the checkpoint key ${label}`,
    fixture: 'casual-anchored' as const,
    context: (c: SpecVerificationContext) =>
      withKeys(c, { checkpointKeys: [{ ...frozenCheckpointKey(), ...entry } as CheckpointPublicKey] }),
  })),
  ...KEY_VARIANTS.map(({ label, entry }) => ({
    name: `exam-v1 with the authority key ${label}`,
    fixture: 'exam-v1' as const,
    withPackage: true,
    context: (c: SpecVerificationContext) =>
      withKeys(c, { examAuthorityKeys: [{ ...frozenExamAuthorityKey(), ...entry } as ExamAuthorityKey] }),
  })),
  {
    name: 'casual with an altered checkpoint signature',
    fixture: 'casual-anchored',
    edit: (p) => {
      const envelope = p.checkpoints![0]!.signature!;
      envelope.signature = flipLastHex(envelope.signature);
    },
  },
  {
    name: 'casual with an altered token payload',
    fixture: 'casual-anchored',
    edit: (p) => {
      p.sessionStartToken!.payload.turnstileVerified = !p.sessionStartToken!.payload.turnstileVerified;
    },
  },
  {
    name: 'casual with checkpoints of another session',
    fixture: 'casual-anchored',
    edit: (p) => {
      for (const cp of p.checkpoints ?? []) if (cp.signature) cp.signature.payload.sessionId = 'another-session';
    },
  },
  {
    name: 'casual without its token',
    fixture: 'casual-anchored',
    edit: (p) => {
      delete p.sessionStartToken;
    },
  },
  {
    name: 'casual without checkpoints',
    fixture: 'casual-anchored',
    edit: (p) => {
      delete p.checkpoints;
    },
  },
  {
    name: 'casual with a PoSW value altered',
    fixture: 'casual-anchored',
    edit: (p) => {
      const e = p.proof.events[5]!;
      e.posw.intermediateHash = flipLastHex(e.posw.intermediateHash);
    },
  },
  {
    name: 'casual with a sequence break',
    fixture: 'casual-anchored',
    edit: (p) => {
      p.proof.events[3]!.sequence = 99;
    },
  },
  {
    name: 'casual with an altered typingProofHash',
    fixture: 'casual-anchored',
    edit: (p) => {
      p.typingProofHash = flipLastHex(p.typingProofHash);
    },
  },
  {
    name: 'casual with a recounted metadata mismatch',
    fixture: 'casual-anchored',
    edit: async (p) => {
      p.typingProofData.metadata.pasteEvents += 1;
      p.typingProofHash = await computeHash(JSON.stringify(p.typingProofData));
    },
  },
  {
    name: 'casual with an altered fingerprint hash',
    fixture: 'casual-anchored',
    edit: (p) => {
      p.fingerprint.hash = flipLastHex(p.fingerprint.hash);
    },
  },
  {
    name: 'casual with an altered content',
    fixture: 'casual-anchored',
    edit: (p) => {
      p.content += ' ';
    },
  },
  {
    name: 'casual with an altered final hash field',
    fixture: 'casual-anchored',
    edit: (p) => {
      p.proof.finalHash = flipLastHex(p.proof.finalHash!);
    },
  },
  {
    name: 'casual with an altered unsigned checkpoint value',
    fixture: 'casual-anchored',
    edit: (p) => {
      p.checkpoints![0]!.timestamp += 1;
    },
  },
  {
    name: 'exam-v2 with an altered event',
    fixture: 'exam-v2',
    withPackage: true,
    edit: (p) => {
      p.proof.events[4]!.timestamp += 1;
    },
  },
];

async function verifyVariant(variant: Variant, mode: 'fast' | 'full'): Promise<SpecVerificationResult> {
  const proof = loadFrozenProof(variant.fixture);
  await variant.edit?.(proof);
  const base = frozenContext({
    mode,
    ...(variant.withPackage && variant.fixture !== 'casual-anchored'
      ? { examPackage: loadFrozenExamPackage(variant.fixture) }
      : {}),
  });
  return verifyProofBySpec(proof, variant.context ? variant.context(base) : base);
}

describe('verifyProofBySpec is never laxer than the legacy verifier', () => {
  it.each(VARIANTS.flatMap((v) => (['fast', 'full'] as const).map((mode) => ({ ...v, mode }))))(
    'fails the integrity exactly when legacy integrityValid is false or the binding fails: $name ($mode)',
    async (variant) => {
      const result = await verifyVariant(variant, variant.mode);
      const legacyRejects =
        result.detail?.legacyProof.integrityValid !== true || result.checks.problemBinding.status === 'fail';
      expect(result.integrity === 'failed').toBe(legacyRejects);
    },
    FULL_VERIFY_TIMEOUT_MS
  );

  it('covers both outcomes among the variants (the comparison is not vacuous)', async () => {
    const outcomes = new Set<boolean>();
    for (const variant of VARIANTS) outcomes.add((await verifyVariant(variant, 'fast')).integrity === 'failed');
    expect([...outcomes].sort()).toEqual([false, true]);
  });
});
