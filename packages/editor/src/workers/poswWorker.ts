/**
 * PoSW (Proof of Sequential Work) Web Worker
 * 重い暗号計算をメインスレッドから分離
 *
 * NOTE: このファイルは @typedcode/shared/src/poswWorker.ts のコピーです。
 * Viteがsymlinkedパッケージ内のWorkerを正しく解決できないため、
 * editorパッケージに配置しています。
 */

// メッセージタイプ定義
export interface ComputePoSWRequest {
  type: 'compute-posw';
  requestId: number;
  previousHash: string;
  eventDataString: string;
  iterations: number;
}

export interface ComputePoSWResponse {
  type: 'posw-result';
  requestId: number;
  iterations: number;
  nonce: string;
  intermediateHash: string;
  computeTimeMs: number;
}

export interface VerifyPoSWRequest {
  type: 'verify-posw';
  requestId: number;
  previousHash: string;
  eventDataString: string;
  nonce: string;
  iterations: number;
  expectedHash: string;
}

export interface VerifyPoSWResponse {
  type: 'verify-result';
  requestId: number;
  valid: boolean;
}

export type WorkerRequest = ComputePoSWRequest | VerifyPoSWRequest;
export type WorkerResponse = ComputePoSWResponse | VerifyPoSWResponse;

// ArrayBufferを16進数文字列に変換
function arrayBufferToHex(buffer: ArrayBuffer): string {
  const uint8Array = new Uint8Array(buffer);
  return Array.from(uint8Array)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// 文字列からSHA-256ハッシュを計算
async function computeHash(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  return arrayBufferToHex(hashBuffer);
}

// ランダムなnonce（16バイト）を生成
export function generateNonce(): string {
  const nonceData = new Uint8Array(16);
  crypto.getRandomValues(nonceData);
  return arrayBufferToHex(nonceData.buffer);
}

// PoSW計算。createNonce はテストが固定ベクタの seed を組むために差し替える (#587)
export async function handleComputePoSW(
  request: ComputePoSWRequest,
  createNonce: () => string = generateNonce
): Promise<ComputePoSWResponse> {
  const startTime = performance.now();
  const nonce = createNonce();

  // 初期入力: 前のハッシュ + イベントデータ + nonce
  let hash = await computeHash(request.previousHash + request.eventDataString + nonce);

  // SHA-256を反復（逐次計算を強制）
  for (let i = 1; i < request.iterations; i++) {
    hash = await computeHash(hash);
  }

  const computeTimeMs = performance.now() - startTime;

  return {
    type: 'posw-result',
    requestId: request.requestId,
    iterations: request.iterations,
    nonce,
    intermediateHash: hash,
    computeTimeMs,
  };
}

// PoSW検証
export async function handleVerifyPoSW(request: VerifyPoSWRequest): Promise<VerifyPoSWResponse> {
  let hash = await computeHash(request.previousHash + request.eventDataString + request.nonce);

  for (let i = 1; i < request.iterations; i++) {
    hash = await computeHash(hash);
  }

  return {
    type: 'verify-result',
    requestId: request.requestId,
    valid: hash === request.expectedHash,
  };
}

// リクエストの振り分け (Worker の外からも呼べる。固定ベクタのテストは __tests__/poswWorker.test.ts)
export async function handleWorkerRequest(request: WorkerRequest): Promise<WorkerResponse> {
  switch (request.type) {
    case 'compute-posw':
      return handleComputePoSW(request);
    case 'verify-posw':
      return handleVerifyPoSW(request);
  }
}

// メッセージハンドラ。本物の Worker の中でだけ張る (テストで import したときに window へ張らない)
if (typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined') {
  self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
    self.postMessage(await handleWorkerRequest(event.data));
  };
}
