/**
 * PoSW (Proof of Sequential Work) Web Worker
 * 重い暗号計算をメインスレッドから分離
 *
 * NOTE: このファイルは @typedcode/shared/src/poswWorker.ts のコピーです。
 * Viteがsymlinkedパッケージ内のWorkerを正しく解決できないため、
 * editorパッケージに配置しています。
 */

// メッセージタイプ定義
interface ComputePoSWRequest {
  type: 'compute-posw';
  requestId: number;
  previousHash: string;
  eventDataString: string;
  iterations: number;
}

interface ComputePoSWResponse {
  type: 'posw-result';
  requestId: number;
  iterations: number;
  nonce: string;
  intermediateHash: string;
  computeTimeMs: number;
}

interface VerifyPoSWRequest {
  type: 'verify-posw';
  requestId: number;
  previousHash: string;
  eventDataString: string;
  nonce: string;
  iterations: number;
  expectedHash: string;
}

interface VerifyPoSWResponse {
  type: 'verify-result';
  requestId: number;
  valid: boolean;
}

type WorkerRequest = ComputePoSWRequest | VerifyPoSWRequest;
type WorkerResponse = ComputePoSWResponse | VerifyPoSWResponse;

// ArrayBufferを16進数文字列に変換
function arrayBufferToHex(buffer: ArrayBuffer): string {
  const uint8Array = new Uint8Array(buffer);
  return Array.from(uint8Array)
    .map(b => b.toString(16).padStart(2, '0'))
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
function generateNonce(): string {
  const nonceData = new Uint8Array(16);
  crypto.getRandomValues(nonceData);
  return arrayBufferToHex(nonceData.buffer);
}

// PoSW計算
async function handleComputePoSW(request: ComputePoSWRequest): Promise<ComputePoSWResponse> {
  const startTime = performance.now();
  const nonce = generateNonce();

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
    computeTimeMs
  };
}

// PoSW検証
async function handleVerifyPoSW(request: VerifyPoSWRequest): Promise<VerifyPoSWResponse> {
  let hash = await computeHash(request.previousHash + request.eventDataString + request.nonce);

  for (let i = 1; i < request.iterations; i++) {
    hash = await computeHash(hash);
  }

  return {
    type: 'verify-result',
    requestId: request.requestId,
    valid: hash === request.expectedHash
  };
}

// メッセージハンドラ
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  let response: WorkerResponse;

  switch (request.type) {
    case 'compute-posw':
      response = await handleComputePoSW(request);
      break;
    case 'verify-posw':
      response = await handleVerifyPoSW(request);
      break;
  }

  self.postMessage(response);
};
