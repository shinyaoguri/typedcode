/**
 * ZIP 展開の DoS ガード (zip bomb) — 予算付きリーダー
 *
 * ZIP のヘッダに書かれた `uncompressedSize` / `compressedSize` は**攻撃者が自由に書ける申告値**
 * なので、申告値の合計や圧縮比を見るガードは「300 MiB のゼロを 1 バイトと名乗る」ZIP を素通しする
 * (#234)。JSZip の `entry.async(...)` は最後まで展開してから size mismatch を投げるため、
 * その時点で採点者のブラウザは既に数百 MB を確保している。
 *
 * したがって上限は**展開中に実際に出てきたバイト数**で見る:
 * - `assertZipWithinBudget` は申告値による**早期 reject** (正直な zip bomb を展開前に落とす)
 * - `ZipExtractionBudget` + `readZipEntryBytes` / `readZipEntryText` が**実バイト**を計上し、
 *   上限を超えた時点でストリームを止めて `ZipBudgetExceededError` を投げる
 *
 * ZIP エントリの読み出しは shared / verify とも必ずこの 2 関数を通す
 * (`__tests__/zipReadPolicy.test.ts` が `.async('string')` 等の直接呼び出しを禁止する)。
 */

import type JSZip from 'jszip';

/** 全エントリの解凍後合計サイズ上限 (bytes)。正規 proof (スクショ込み) でも十分余裕がある。 */
export const MAX_ZIP_TOTAL_UNCOMPRESSED = 256 * 1024 * 1024; // 256 MB
/** エントリ数上限。 */
export const MAX_ZIP_ENTRIES = 5000;

/** 展開中の実バイト数が予算を超えたときに投げる。呼び出し側が他のエラーと区別できるよう `name` 固定。 */
export class ZipBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipBudgetExceededError';
  }
}

/**
 * ZIP 1 個の展開で許す**実バイト**総量。`readZipEntryBytes` が展開しながら計上する。
 *
 * エントリ名ごとに計上済みバイト数を持ち、**同じエントリを読み直しても二重計上しない**
 * (verify は screenshots を `extractFiles` と `loadScreenshots` で 2 回読む)。
 */
export class ZipExtractionBudget {
  /** エントリ名 → そのエントリで計上済みの最大バイト数。 */
  private readonly chargedByEntry = new Map<string, number>();
  private total = 0;

  constructor(private readonly limitBytes: number = MAX_ZIP_TOTAL_UNCOMPRESSED) {}

  /** これまでに計上した実バイト総量。 */
  get used(): number {
    return this.total;
  }

  /** 予算 (bytes)。 */
  get limit(): number {
    return this.limitBytes;
  }

  /**
   * エントリ `entryName` の先頭から数えた累計 `cumulativeBytes` を計上する。
   * 既に計上済みの分は増分だけを足す (再読込は二重計上しない)。
   *
   * @throws {ZipBudgetExceededError} 総量が予算を超えたとき
   */
  charge(entryName: string, cumulativeBytes: number): void {
    const alreadyCharged = this.chargedByEntry.get(entryName) ?? 0;
    if (cumulativeBytes <= alreadyCharged) return;

    this.chargedByEntry.set(entryName, cumulativeBytes);
    this.total += cumulativeBytes - alreadyCharged;

    if (this.total > this.limitBytes) {
      throw new ZipBudgetExceededError(
        `ZIP extraction exceeds budget (${this.total} > ${this.limitBytes} bytes) at entry: ${entryName}`
      );
    }
  }
}

/**
 * 高圧縮率の悪意ある ZIP (zip bomb) を**展開前に**落とすための早期ガード。
 *
 * ここで見るのは中央ディレクトリの**申告値**なので、詐称された ZIP は通ってしまう。
 * 実際の歯止めは `readZipEntryBytes` の実バイト計上 (#234)。この関数はエントリ数上限と、
 * 正直な zip bomb の早期 reject を担う。
 *
 * 申告値が取れない非ディレクトリエントリは **fail-closed** で throw する。JSZip の内部構造
 * (`_data.uncompressedSize`) が変わったら round-trip テストが赤くなり、黙って無検査になるのを防ぐ。
 */
export function assertZipWithinBudget(zip: JSZip): void {
  const names = Object.keys(zip.files);
  if (names.length > MAX_ZIP_ENTRIES) {
    throw new Error(`ZIP has too many entries (${names.length} > ${MAX_ZIP_ENTRIES})`);
  }
  let total = 0;
  for (const name of names) {
    // `_data.uncompressedSize` は JSZip 内部だが `loadAsync` 経路では中央ディレクトリ由来で安定。
    const f = zip.files[name] as unknown as { dir?: boolean; _data?: { uncompressedSize?: number } };
    if (f?.dir) continue; // ディレクトリはサイズを持たない
    const declared = f?._data?.uncompressedSize;
    if (typeof declared !== 'number' || !Number.isFinite(declared) || declared < 0) {
      throw new Error(`ZIP entry has no readable declared size: ${name}`);
    }
    total += declared;
    if (total > MAX_ZIP_TOTAL_UNCOMPRESSED) {
      throw new Error(`ZIP uncompressed size exceeds limit (${MAX_ZIP_TOTAL_UNCOMPRESSED} bytes)`);
    }
  }
}

/** `internalStream` は JSZip の型定義に無い (実装には存在する)。用途を 1 箇所に閉じ込めるための最小の型。 */
type InternalStreamCapable = {
  internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
};

/**
 * ZIP エントリを**予算内で**バイト列として読み出す。
 *
 * `internalStream` は pako の inflate 出力をチャンクで流すので、チャンクごとに実バイトを計上し、
 * 予算超過の時点で `pause()` して reject する。以降に届く `data` / `end` は無視する (捨てる)。
 * `pause()` は展開中の 1 入力ブロック (16 KiB) を止められないので、ストリームは予算より
 * 最大 ~16 MiB 多く流れうる (ゼロ列の実測で ~15 MiB) が、保持するのは予算ぶんだけで頭打ち。
 *
 * 返り値は常に**専用の `ArrayBuffer` を丸ごと使う** `Uint8Array` (byteOffset 0 / 全長) なので、
 * 呼び出し側は `.buffer` をそのまま `ArrayBuffer` として渡してよい。
 */
export function readZipEntryBytes(entry: JSZip.JSZipObject, budget: ZipExtractionBudget): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const stream = (entry as unknown as InternalStreamCapable).internalStream('uint8array');
    const chunks: Uint8Array[] = [];
    let received = 0;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      chunks.length = 0; // 途中まで溜めた分を手放す (予算超過時に保持し続けない)
      stream.pause();
      reject(error);
    };

    stream.on('data', (chunk: Uint8Array) => {
      if (settled) return;
      received += chunk.length;
      try {
        budget.charge(entry.name, received);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', (error: Error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      const out = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(out);
    });
    stream.resume();
  });
}

/**
 * ZIP エントリを**予算内で** UTF-8 テキストとして読み出す (JSZip の `async('string')` 相当)。
 * BOM は `TextDecoder` が落とすので JSZip より寛容になる。
 */
export async function readZipEntryText(entry: JSZip.JSZipObject, budget: ZipExtractionBudget): Promise<string> {
  const bytes = await readZipEntryBytes(entry, budget);
  return new TextDecoder('utf-8').decode(bytes);
}
