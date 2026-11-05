/**
 * 記録側の PoSW Web Worker (`poswWorker.ts`) を固定ベクタで縛る (#587)。
 *
 * 記録側は `await crypto.subtle.digest` の反復、検証側 (`verifyPoSW`) は同期の
 * `iterateSha256HexSync` で、実装が別にある (shared/AGENTS.md「よくある罠」)。検証側は
 * `poswSync.test.ts` が固定ベクタで縛っているので、記録側も同じ表 (`fixtures/poswVectors.ts`) で縛り、
 * どちらかの手順 (例: 反復の入力を 16 進文字列の UTF-8 から生バイトに変える) だけが変わったら落とす。
 *
 * editor は Worker 本体をコピーして持つ (`packages/editor/src/workers/poswWorker.ts`)。両者の一致は
 * editor の `poswWorkerCopy.test.ts` が縛るので、ここでは shared 側だけを呼べば足りる。
 */

import { describe, expect, it } from 'vitest';
import {
  type ComputePoSWRequest,
  generateNonce,
  handleComputePoSW,
  handleVerifyPoSW,
  handleWorkerRequest,
  type VerifyPoSWRequest,
} from '../poswWorker.js';
import { POSW_FIXED_VECTORS } from './fixtures/poswVectors.js';

/**
 * seed を Worker の入力 (`previousHash + eventDataString + nonce`) に 3 分割する。
 * 3 つとも seed の一部を担わせ、連結の順序や nonce の取りこぼしもベクタとの不一致で見えるようにする。
 */
function splitSeed(seed: string): { previousHash: string; eventDataString: string; nonce: string } {
  const chars = Array.from(seed);
  const a = Math.ceil(chars.length / 3);
  const b = Math.ceil((chars.length * 2) / 3);
  return {
    previousHash: chars.slice(0, a).join(''),
    eventDataString: chars.slice(a, b).join(''),
    nonce: chars.slice(b).join(''),
  };
}

function computeRequest(seed: string, iterations: number, requestId = 7): ComputePoSWRequest {
  const { previousHash, eventDataString } = splitSeed(seed);
  return { type: 'compute-posw', requestId, previousHash, eventDataString, iterations };
}

function verifyRequest(seed: string, iterations: number, expectedHash: string): VerifyPoSWRequest {
  const { previousHash, eventDataString, nonce } = splitSeed(seed);
  return { type: 'verify-posw', requestId: 11, previousHash, eventDataString, nonce, iterations, expectedHash };
}

/** 先頭の 16 進 1 文字だけを変える */
function flipFirstHexChar(hash: string): string {
  return `${hash.startsWith('0') ? '1' : '0'}${hash.slice(1)}`;
}

describe('poswWorker: handleComputePoSW', () => {
  it.each(POSW_FIXED_VECTORS)('matches the fixed vector (seed=%j, n=%i)', async (seed, iterations, expected) => {
    const { nonce } = splitSeed(seed);
    const response = await handleComputePoSW(computeRequest(seed, iterations), () => nonce);

    expect(response.intermediateHash).toBe(expected);
    expect(response).toMatchObject({ type: 'posw-result', requestId: 7, iterations, nonce });
    expect(response.computeTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('uses a random 16-byte lowercase hex nonce by default', async () => {
    const first = await handleComputePoSW(computeRequest('typedcode-posw', 1));
    const second = await handleComputePoSW(computeRequest('typedcode-posw', 1));

    expect(first.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(second.nonce).not.toBe(first.nonce);
  });
});

describe('poswWorker: handleVerifyPoSW', () => {
  it.each(POSW_FIXED_VECTORS)('accepts the fixed vector (seed=%j, n=%i)', async (seed, iterations, expected) => {
    expect(await handleVerifyPoSW(verifyRequest(seed, iterations, expected))).toEqual({
      type: 'verify-result',
      requestId: 11,
      valid: true,
    });
  });

  it.each(POSW_FIXED_VECTORS)(
    'rejects a hash differing by one character (seed=%j, n=%i)',
    async (seed, iterations, expected) => {
      const response = await handleVerifyPoSW(verifyRequest(seed, iterations, flipFirstHexChar(expected)));
      expect(response.valid).toBe(false);
    }
  );
});

describe('poswWorker: handleWorkerRequest', () => {
  it('dispatches compute-posw and verify-posw by type', async () => {
    const computed = await handleWorkerRequest(computeRequest('typedcode-posw', 2));
    expect(computed.type).toBe('posw-result');
    if (computed.type !== 'posw-result') return;

    const verified = await handleWorkerRequest({
      type: 'verify-posw',
      requestId: 3,
      previousHash: 'typ',
      eventDataString: 'edcode-',
      nonce: computed.nonce,
      iterations: 2,
      expectedHash: computed.intermediateHash,
    });
    expect(verified).toEqual({ type: 'verify-result', requestId: 3, valid: true });
  });

  it('generateNonce returns 32 lowercase hex characters', () => {
    expect(generateNonce()).toMatch(/^[0-9a-f]{32}$/);
  });
});
