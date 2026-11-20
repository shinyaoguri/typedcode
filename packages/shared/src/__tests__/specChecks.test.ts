/**
 * legacy 1.2.0 の結果を項目別の検査へ写す規則を固定する (#809)。
 *
 * - 落ちた検査は `fail` (code つき)
 * - 前段の失敗で実際には走っていない検査は `fail` ではなく `not-checked`
 * - 走っていない検査を `pass` にしない
 *
 * 凍結 proof を 1 か所だけ書き換えて、どの検査に出るかを確かめる (fixture のファイルは書き換えない)。
 */

import { describe, expect, it } from 'vitest';
import {
  computeHash,
  verifyProofBySpec,
  verifyProofFile,
  type ProofFile,
  type SpecVerificationResult,
} from '../index.js';
import { FULL_VERIFY_TIMEOUT_MS, frozenContext, loadFrozenProof } from './fixtures/frozenProofFixtures.js';

/** 16 進文字列の最後の 1 文字を別の 16 進文字に変える */
function flipLastHex(hex: string): string {
  return hex.slice(0, -1) + (hex.at(-1) === '0' ? '1' : '0');
}

async function verifyEdited(
  edit: (proof: ProofFile) => void | Promise<void>,
  mode: 'fast' | 'full' = 'fast'
): Promise<SpecVerificationResult> {
  const proof = loadFrozenProof('casual-anchored');
  await edit(proof);
  return verifyProofBySpec(proof, frozenContext({ mode }));
}

/** 5 番目のイベントの PoSW の中間値だけを書き換える (イベントのハッシュ入力なので hash も合わなくなる) */
const alterPosw = (proof: ProofFile) => {
  const event = proof.proof.events[5]!;
  event.posw.intermediateHash = flipLastHex(event.posw.intermediateHash);
};

describe('verifyProofBySpec check mapping: PoSW tampered', () => {
  it(
    'reports PoSW as failed in full mode',
    async () => {
      expect((await verifyEdited(alterPosw, 'full')).checks.posw).toEqual({ status: 'fail', code: 'posw-mismatch' });
    },
    FULL_VERIFY_TIMEOUT_MS
  );

  it(
    'reports the chain as not checked in full mode because it stopped at the PoSW',
    async () => {
      expect((await verifyEdited(alterPosw, 'full')).checks.chain).toEqual({ status: 'not-checked' });
    },
    FULL_VERIFY_TIMEOUT_MS
  );

  it('reports the chain as failed in fast mode because the event hash no longer matches', async () => {
    expect((await verifyEdited(alterPosw)).checks.chain).toEqual({ status: 'fail', code: 'hash-mismatch' });
  });

  it('reports the final hash as not checked when the chain stopped early', async () => {
    expect((await verifyEdited(alterPosw)).checks.finalHash).toEqual({ status: 'not-checked' });
  });

  it('reports the integrity as failed even in fast mode', async () => {
    expect((await verifyEdited(alterPosw)).integrity).toBe('failed');
  });
});

describe('verifyProofBySpec check mapping: chain tampered', () => {
  it(
    'reports PoSW as not checked in full mode when the chain fails first',
    async () => {
      const result = await verifyEdited((proof) => {
        proof.proof.events[3]!.sequence = 99;
      }, 'full');
      expect(result.checks.posw).toEqual({ status: 'not-checked' });
    },
    FULL_VERIFY_TIMEOUT_MS
  );

  it.each([
    {
      code: 'sequence-mismatch',
      edit: (proof: ProofFile) => {
        proof.proof.events[3]!.sequence = 99;
      },
    },
    {
      code: 'timestamp-regression',
      edit: (proof: ProofFile) => {
        proof.proof.events[3]!.timestamp = -1;
      },
    },
    {
      code: 'previous-hash-mismatch',
      edit: (proof: ProofFile) => {
        proof.proof.events[3]!.previousHash = flipLastHex(proof.proof.events[3]!.previousHash!);
      },
    },
    {
      code: 'posw-iterations-mismatch',
      edit: (proof: ProofFile) => {
        proof.proof.events[3]!.posw.iterations += 1;
      },
    },
  ])('reports the chain as failed with $code', async ({ code, edit }) => {
    expect((await verifyEdited(edit)).checks.chain).toEqual({ status: 'fail', code });
  });
});

describe('verifyProofBySpec check mapping: other evidence', () => {
  it('reports a changed typingProofHash as a metadata failure without failing the root', async () => {
    const result = await verifyEdited((proof) => {
      proof.typingProofHash = flipLastHex(proof.typingProofHash);
    });
    expect([result.checks.metadata, result.checks.root]).toEqual([
      { status: 'fail', code: 'typing-proof-hash-mismatch' },
      { status: 'pass' },
    ]);
  });

  it('reports a claimed event count that disagrees with the events as an event metadata failure', async () => {
    const result = await verifyEdited(async (proof) => {
      proof.typingProofData.metadata.pasteEvents += 1;
      // typingProofHash を作り直して、ハッシュの照合ではなく再カウントで落ちるようにする
      proof.typingProofHash = await computeHash(JSON.stringify(proof.typingProofData));
    });
    expect(result.checks.metadata).toEqual({ status: 'fail', code: 'event-metadata-mismatch' });
  });

  it('reports a fingerprint hash that no longer matches the device as a root failure', async () => {
    const result = await verifyEdited((proof) => {
      proof.fingerprint.hash = flipLastHex(proof.fingerprint.hash);
    });
    expect(result.checks.root).toEqual({ status: 'fail', code: 'root-mismatch' });
  });

  it('reports the session anchor as not checked when the root itself fails', async () => {
    const result = await verifyEdited((proof) => {
      proof.fingerprint.hash = flipLastHex(proof.fingerprint.hash);
    });
    expect(result.checks.sessionAnchor).toEqual({ status: 'not-checked' });
  });

  it('reports a changed content as a content failure', async () => {
    const result = await verifyEdited((proof) => {
      proof.content += ' ';
    });
    expect(result.checks.content).toEqual({ status: 'fail', code: 'content-mismatch' });
  });

  it('reports a changed final hash field as a final hash failure', async () => {
    const result = await verifyEdited((proof) => {
      proof.proof.finalHash = flipLastHex(proof.proof.finalHash!);
    });
    expect(result.checks.finalHash).toEqual({ status: 'fail', code: 'final-hash-mismatch' });
  });

  it('reports a changed unsigned checkpoint value as a checkpoint failure', async () => {
    const result = await verifyEdited((proof) => {
      proof.checkpoints![0]!.timestamp += 1;
    });
    expect(result.checks.checkpoints).toEqual({ status: 'fail', code: 'checkpoint-mismatch' });
  });

  it('reports an absent checkpoint list as not applicable', async () => {
    const result = await verifyEdited((proof) => {
      delete proof.checkpoints;
    });
    expect([result.checks.checkpoints, result.checks.signedCheckpoints]).toEqual([
      { status: 'not-applicable' },
      { status: 'not-applicable' },
    ]);
  });

  it('reports a token whose signed payload changed as a session anchor failure without failing the integrity', async () => {
    const result = await verifyEdited((proof) => {
      proof.sessionStartToken!.payload.turnstileVerified = !proof.sessionStartToken!.payload.turnstileVerified;
    });
    expect([result.checks.sessionAnchor, result.integrity]).toEqual([
      { status: 'fail', code: 'token-invalid' },
      'partial',
    ]);
  });

  it('reports signed checkpoints of another session as a session anchor failure', async () => {
    // token は無傷のまま、署名 cp の sessionId だけを別の値にする (cp の署名は合わなくなる)
    const result = await verifyEdited((proof) => {
      for (const cp of proof.checkpoints ?? []) {
        if (cp.signature) cp.signature.payload.sessionId = 'another-session';
      }
    });
    expect(result.checks.sessionAnchor).toEqual({ status: 'fail', code: 'token-session-mismatch' });
  });

  it('reports the session anchor as not applicable without a token', async () => {
    const result = await verifyEdited((proof) => {
      delete proof.sessionStartToken;
    });
    expect(result.checks.sessionAnchor).toEqual({ status: 'not-applicable' });
  });
});

describe('verifyProofFile fields read by the check mapping (#809)', () => {
  it('leaves the metadata breakdown unset instead of throwing when the typing proof hash is missing', async () => {
    const proof = loadFrozenProof('casual-anchored');
    delete (proof as Partial<ProofFile>).typingProofHash;
    const result = await verifyProofFile(proof, undefined, { mode: 'fast', signedCheckpointKeyRegistry: [] });
    expect([result.typingProofHashValid, result.eventMetadataValid]).toEqual([undefined, undefined]);
  });
});
