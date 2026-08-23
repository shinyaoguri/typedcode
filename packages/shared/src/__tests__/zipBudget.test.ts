import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  ZipBudgetExceededError,
  ZipExtractionBudget,
  assertZipWithinBudget,
  readZipEntryBytes,
  readZipEntryText,
} from '../fileProcessing/zipBudget.js';
import { extractAllProofsFromZip } from '../fileProcessing/parser.js';

const MIB = 1024 * 1024;

/**
 * 申告 `uncompressedSize` を 1 バイトと詐称した ZIP を作る (#234 の再現)。
 *
 * ゼロ列は DEFLATE で 1000:1 近くまで縮むので、数十 KB の ZIP が数十 MB に展開される。
 * ローカルヘッダ (`PK\x03\x04` +22) と中央ディレクトリ (`PK\x01\x02` +24) の uint32 LE を
 * 書き換えるだけで、JSZip は「1 バイトのエントリ」として読み込む。
 */
async function buildDeclaredSizeForgedZip(entryName: string, payloadBytes: number): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(entryName, new Uint8Array(payloadBytes));
  const bytes = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // EOCD (`PK\x05\x06`) を末尾から探して中央ディレクトリの位置を得る (署名バイト列の誤検出を避ける)
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('EOCD not found');
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);
  if (view.getUint32(0, true) !== 0x04034b50) throw new Error('local file header is not at offset 0');
  if (view.getUint32(centralDirOffset, true) !== 0x02014b50) throw new Error('central directory header not found');

  view.setUint32(22, 1, true);
  view.setUint32(centralDirOffset + 24, 1, true);
  return bytes;
}

/**
 * zip 爆弾ガード (#149 / #234)。verify の ZipFileProcessor など shared の parser を経由しない
 * 消費者からも呼ばれる public API なので、上限判定そのものを固定する。
 */
describe('assertZipWithinBudget', () => {
  it('accepts a real zip round-tripped through JSZip', async () => {
    const zip = new JSZip();
    zip.file('proof.json', '{"proof":{}}');
    zip.file('screenshots/1.png', new Uint8Array(1024));
    const buf = await zip.generateAsync({ type: 'uint8array' });
    const loaded = await JSZip.loadAsync(buf);

    expect(() => assertZipWithinBudget(loaded)).not.toThrow();
  });

  it('rejects a zip with more entries than the entry budget', () => {
    const files: Record<string, unknown> = {};
    for (let i = 0; i <= 5000; i++) {
      files[`f${i}`] = { _data: { uncompressedSize: 1 } };
    }
    const fake = { files } as unknown as JSZip;

    expect(() => assertZipWithinBudget(fake)).toThrow(/too many entries/);
  });

  it('rejects a zip whose declared uncompressed total exceeds the size budget', () => {
    const fake = {
      files: {
        'a.bin': { _data: { uncompressedSize: 200 * MIB } },
        'b.bin': { _data: { uncompressedSize: 200 * MIB } },
      },
    } as unknown as JSZip;

    expect(() => assertZipWithinBudget(fake)).toThrow(/uncompressed size exceeds/);
  });

  it('rejects a file entry whose declared uncompressed size is unreadable', () => {
    // JSZip の内部構造が変わって申告値が取れなくなったら、黙って無検査になるのではなく落ちる
    const fake = { files: { 'a.bin': { dir: false, _data: {} } } } as unknown as JSZip;

    expect(() => assertZipWithinBudget(fake)).toThrow(/no readable declared size/);
  });

  it('accepts a zip that lies about its uncompressed size (declared sizes are not a defense)', async () => {
    const forged = await buildDeclaredSizeForgedZip('big.json', 32 * MIB);
    const zip = await JSZip.loadAsync(forged);

    const declared = (zip.files['big.json'] as unknown as { _data: { uncompressedSize: number } })._data
      .uncompressedSize;
    expect(declared).toBe(1);
    expect(() => assertZipWithinBudget(zip)).not.toThrow();
  });
});

describe('ZipExtractionBudget', () => {
  it('throws ZipBudgetExceededError once charged beyond its limit', () => {
    const budget = new ZipExtractionBudget(1024);

    expect(() => budget.charge('a.bin', 1025)).toThrow(ZipBudgetExceededError);
  });

  it('does not charge the same entry twice when it is read again', () => {
    const budget = new ZipExtractionBudget(1024);
    budget.charge('a.bin', 512);
    budget.charge('a.bin', 512); // 2 回目の読み出し (verify は screenshots を 2 度読む)

    expect(budget.used).toBe(512);
  });
});

describe('readZipEntryBytes', () => {
  it('stops extracting an entry that lies about its size once the budget is spent', async () => {
    const forged = await buildDeclaredSizeForgedZip('big.json', 32 * MIB);
    const zip = await JSZip.loadAsync(forged);
    const budget = new ZipExtractionBudget(1 * MIB);

    await expect(readZipEntryBytes(zip.file('big.json')!, budget)).rejects.toThrow(ZipBudgetExceededError);

    // 計上は予算超過を見た瞬間に止まる (実測 1 MiB + 16 KiB = pako の出力チャンク 1 個ぶん)。
    // ストリーム自体は pause() が効くまで 1 入力ブロック分 (実測 ~15 MiB) 余分に流れるが、
    // その分は捨てるので保持量は予算 + チャンク 1 個で頭打ちになる。全展開 (32 MiB) とは桁が違う。
    expect(budget.used).toBeLessThanOrEqual(2 * MIB);
  }, 60_000);

  it('reads a whole entry when it fits in the budget', async () => {
    const zip = new JSZip();
    zip.file('a.bin', new Uint8Array([1, 2, 3, 4]));
    const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array' }));
    const budget = new ZipExtractionBudget(1 * MIB);

    const bytes = await readZipEntryBytes(loaded.file('a.bin')!, budget);

    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
    expect(budget.used).toBe(4);
  });

  it('charges a re-read entry only once so a second pass over screenshots still fits', async () => {
    const zip = new JSZip();
    zip.file('screenshots/1.png', new Uint8Array(4096));
    const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array' }));
    const budget = new ZipExtractionBudget(6000);
    const entry = loaded.file('screenshots/1.png')!;

    await readZipEntryBytes(entry, budget);
    await readZipEntryBytes(entry, budget);

    expect(budget.used).toBe(4096);
  });
});

describe('readZipEntryText', () => {
  it('decodes entry bytes as UTF-8', async () => {
    const zip = new JSZip();
    zip.file('note.txt', 'こんにちは proof');
    const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array' }));

    const text = await readZipEntryText(loaded.file('note.txt')!, new ZipExtractionBudget(1 * MIB));

    expect(text).toBe('こんにちは proof');
  });
});

describe('extractAllProofsFromZip', () => {
  it('rejects a zip that lies about its size instead of expanding it', async () => {
    const forged = await buildDeclaredSizeForgedZip('big.json', 32 * MIB);

    await expect(
      extractAllProofsFromZip(forged.buffer as ArrayBuffer, new ZipExtractionBudget(1 * MIB))
    ).rejects.toThrow(ZipBudgetExceededError);
  }, 60_000);

  it('reads proofs from an honest zip within the budget', async () => {
    const zip = new JSZip();
    zip.file('a_proof.json', JSON.stringify({ proof: { events: [] }, typingProofHash: 'abc' }));
    const buf = await zip.generateAsync({ type: 'uint8array' });

    const proofs = await extractAllProofsFromZip(buf.buffer as ArrayBuffer);

    expect(proofs.map((p) => p.filename)).toEqual(['a_proof.json']);
  });
});
