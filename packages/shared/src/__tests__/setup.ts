/**
 * Vitest Global Setup
 * Provides mocks for browser APIs not supported by happy-dom
 */

import { vi } from 'vitest';
import * as nodeCrypto from 'crypto';

// ===== crypto.subtle モック =====
// happy-dom does not support crypto.subtle, so we use Node.js crypto
const cryptoMock = {
  subtle: {
    digest: async (_algorithm: string, data: ArrayBuffer): Promise<ArrayBuffer> => {
      const hash = nodeCrypto.createHash('sha256');
      hash.update(Buffer.from(data));
      // Return a copy of the buffer to avoid issues with shared memory
      const result = hash.digest();
      return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
    },
  },
  getRandomValues: <T extends ArrayBufferView>(array: T): T => {
    const bytes = nodeCrypto.randomBytes(array.byteLength);
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes);
    return array;
  },
  randomUUID: (): `${string}-${string}-${string}-${string}-${string}` => {
    return nodeCrypto.randomUUID();
  },
};

vi.stubGlobal('crypto', cryptoMock);

// ===== Worker モック =====
// TypingProof uses Web Worker for PoSW computation
class MockWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor(_scriptURL: string | URL, _options?: WorkerOptions) {
    // Worker is not actually created in tests
  }

  postMessage(message: Record<string, unknown>): void {
    // Use queueMicrotask to simulate async behavior
    queueMicrotask(() => {
      if (this.onmessage) {
        const response = this.createMockResponse(message);
        this.onmessage({ data: response } as MessageEvent);
      }
    });
  }

  private createMockResponse(request: Record<string, unknown>): unknown {
    switch (request.type) {
      case 'compute-posw':
        return {
          type: 'posw-result',
          requestId: request.requestId,
          iterations: request.iterations,
          nonce: 'mock-nonce-' + Date.now().toString(16),
          intermediateHash: 'mock-intermediate-hash-' + Date.now().toString(16),
          computeTimeMs: 5,
        };
      case 'verify-posw':
        return {
          type: 'verify-result',
          requestId: request.requestId,
          valid: true,
        };
      default:
        return {};
    }
  }

  terminate(): void {
    // no-op
  }
}

vi.stubGlobal('Worker', MockWorker);

// ===== Canvas モック強化 =====
// happy-dom's Canvas implementation is limited
HTMLCanvasElement.prototype.getContext = function (contextId: string) {
  if (contextId === '2d') {
    return {
      fillStyle: '',
      textBaseline: 'top',
      font: '',
      fillRect: vi.fn(),
      fillText: vi.fn(),
      measureText: (text: string) => ({ width: text.length * 10 }),
      getImageData: () => ({ data: new Uint8ClampedArray(100) }),
    } as unknown as CanvasRenderingContext2D;
  }
  if (contextId === 'webgl' || contextId === 'experimental-webgl') {
    return {
      VENDOR: 0x1f00,
      RENDERER: 0x1f01,
      VERSION: 0x1f02,
      SHADING_LANGUAGE_VERSION: 0x8b8c,
      getParameter: (param: number) => {
        switch (param) {
          case 0x1f00:
            return 'Mock WebGL Vendor';
          case 0x1f01:
            return 'Mock WebGL Renderer';
          case 0x1f02:
            return 'WebGL 1.0';
          case 0x8b8c:
            return 'WebGL GLSL ES 1.0';
          default:
            return 'Mock Value';
        }
      },
      getExtension: () => null,
    } as unknown as WebGLRenderingContext;
  }
  return null;
} as typeof HTMLCanvasElement.prototype.getContext;

HTMLCanvasElement.prototype.toDataURL = function () {
  return 'data:image/png;base64,mockCanvasDataForTesting';
};

// ===== performance.now モック（必要に応じて） =====
// happy-dom should provide this, but ensure it's available
if (typeof performance === 'undefined' || typeof performance.now !== 'function') {
  const startTime = Date.now();
  vi.stubGlobal('performance', {
    now: () => Date.now() - startTime,
  });
}
