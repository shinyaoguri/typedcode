import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { assertZipWithinBudget } from '../fileProcessing/parser.js';

/**
 * zip 爆弾ガード (#149)。verify の ZipFileProcessor など shared の parser を経由しない
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
        'a.bin': { _data: { uncompressedSize: 200 * 1024 * 1024 } },
        'b.bin': { _data: { uncompressedSize: 200 * 1024 * 1024 } },
      },
    } as unknown as JSZip;

    expect(() => assertZipWithinBudget(fake)).toThrow(/uncompressed size exceeds/);
  });
});
