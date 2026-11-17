import { observePoswWorkerFailure } from '@typedcode/shared';

/**
 * PoSW Worker のファクトリ。editor で PoSW の Worker を作る経路はすべてこの関数を通す。
 *
 * Vite が symlink されたパッケージ内の Worker を正しく解決できないため、editor 内のコピー (`./poswWorker.ts`) を読む。
 *
 * 故障の観測は生成と同じ式 (同期区間) で始める (#701)。呼び出し側 (TabManager) は Turnstile などを待ってから
 * TypingProof に渡すので、attach の時点で付く `onerror` だけでは、その間に出たスクリプトの読み込み失敗の `error` を
 * 取り逃がし、以後のイベントがそれぞれ 30 秒の期限を待つ。**生成と観測の間に await を挟まないこと**。
 */
export function createPoswWorker(): Worker {
  return observePoswWorkerFailure(new Worker(new URL('./poswWorker.ts', import.meta.url), { type: 'module' }));
}
