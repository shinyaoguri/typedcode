/**
 * スクリーンショット検証 (#146/#147) のテスト。
 * verify (web) と verify-cli が共有する単一実装 — ここが壊れると
 * 「Web では改ざん FAILED / CLI では PROVEN + exit 0」型の乖離事故に直結する。
 */

import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  sha256HexOfBytes,
  collectChainImageHashes,
  checkScreenshotImage,
  summarizeScreenshotArtifacts,
  extractScreenshotArtifactsFromZip,
} from '../index.js';
import type { StoredEvent } from '../types.js';

const enc = new TextEncoder();

async function hashOf(text: string): Promise<string> {
  return sha256HexOfBytes(enc.encode(text));
}

describe('sha256HexOfBytes', () => {
  it('computes the SHA-256 of raw bytes as lowercase hex', async () => {
    // 既知ベクトル: SHA-256("abc")
    expect(await hashOf('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('collectChainImageHashes', () => {
  it('collects imageHash values from screenshotCapture events across proofs', () => {
    const eventsA = [
      { type: 'screenshotCapture', data: { imageHash: 'aa' } },
      { type: 'contentChange', data: 'x' },
    ] as unknown as StoredEvent[];
    const eventsB = [{ type: 'screenshotCapture', data: { imageHash: 'bb' } }] as unknown as StoredEvent[];
    expect(collectChainImageHashes([eventsA, eventsB])).toEqual(new Set(['aa', 'bb']));
  });

  it('ignores screenshotCapture events without a usable imageHash', () => {
    const events = [
      { type: 'screenshotCapture', data: {} },
      { type: 'screenshotCapture', data: null },
      { type: 'screenshotCapture', data: { imageHash: '' } },
    ] as unknown as StoredEvent[];
    expect(collectChainImageHashes([events]).size).toBe(0);
  });
});

describe('checkScreenshotImage', () => {
  it('verifies an image whose bytes match the manifest hash and the chain', async () => {
    const bytes = enc.encode('image-1');
    const hash = await sha256HexOfBytes(bytes);
    const check = await checkScreenshotImage(bytes, hash, new Set([hash]));
    expect(check).toEqual({ verified: true, tampered: false });
  });

  it('flags a hash mismatch as tampered', async () => {
    const check = await checkScreenshotImage(enc.encode('swapped'), 'f'.repeat(64), new Set(['f'.repeat(64)]));
    expect(check.tampered).toBe(true);
    expect(check.verified).toBe(false);
  });

  it('flags a manifest+image pair swap: hash self-consistent but not backed by the chain', async () => {
    const bytes = enc.encode('attacker image');
    const hash = await sha256HexOfBytes(bytes);
    const check = await checkScreenshotImage(bytes, hash, new Set(['0'.repeat(64)]));
    expect(check).toEqual({ verified: true, tampered: true });
  });

  it('does not require chain backing when the chain set is empty (old proofs)', async () => {
    const bytes = enc.encode('legacy');
    const hash = await sha256HexOfBytes(bytes);
    expect((await checkScreenshotImage(bytes, hash, new Set())).tampered).toBe(false);
    expect((await checkScreenshotImage(bytes, hash, undefined)).tampered).toBe(false);
  });
});

describe('summarizeScreenshotArtifacts', () => {
  it('counts verified / missing / tampered / chainOnly in one pass', async () => {
    const okBytes = enc.encode('ok');
    const okHash = await sha256HexOfBytes(okBytes);
    const swappedHash = await sha256HexOfBytes(enc.encode('original'));
    const strippedHash = '1'.repeat(64);

    const images = new Map<string, Uint8Array>([
      ['ok.webp', okBytes],
      ['swapped.webp', enc.encode('not the original')],
    ]);
    const summary = await summarizeScreenshotArtifacts({
      entries: [
        { filename: 'ok.webp', imageHash: okHash },
        { filename: 'swapped.webp', imageHash: swappedHash },
        { filename: 'gone.webp', imageHash: '2'.repeat(64) },
      ],
      getImageBytes: async (name) => images.get(name) ?? null,
      chainImageHashes: new Set([okHash, swappedHash, '2'.repeat(64), strippedHash]),
    });

    expect(summary).toEqual({ total: 3, verified: 1, missing: 1, tampered: 1, chainOnly: 1 });
  });

  it('reports stripped screenshots as chainOnly when the manifest is empty or absent', async () => {
    const summary = await summarizeScreenshotArtifacts({
      entries: [],
      getImageBytes: async () => null,
      chainImageHashes: new Set(['a'.repeat(64), 'b'.repeat(64)]),
    });
    expect(summary.total).toBe(0);
    expect(summary.chainOnly).toBe(2);
  });
});

describe('extractScreenshotArtifactsFromZip', () => {
  async function buildZip(files: Record<string, string | Uint8Array>): Promise<ArrayBuffer> {
    const zip = new JSZip();
    for (const [path, content] of Object.entries(files)) {
      zip.file(path, content);
    }
    return zip.generateAsync({ type: 'arraybuffer' });
  }

  it('returns manifest entries and image bytes without judging them', async () => {
    const buffer = await buildZip({
      'screenshots/manifest.json': JSON.stringify({
        version: '1.0',
        screenshots: [
          { filename: 'a.webp', imageHash: 'a'.repeat(64) },
          { filename: 'gone.webp', imageHash: 'b'.repeat(64) },
        ],
      }),
      'screenshots/a.webp': enc.encode('img'),
    });
    const artifacts = await extractScreenshotArtifactsFromZip(buffer);
    expect(artifacts).not.toBeNull();
    expect(artifacts!.entries).toEqual([
      { filename: 'a.webp', imageHash: 'a'.repeat(64) },
      { filename: 'gone.webp', imageHash: 'b'.repeat(64) },
    ]);
    expect(artifacts!.images.has('a.webp')).toBe(true);
    expect(artifacts!.images.has('gone.webp')).toBe(false);
  });

  it('supports the legacy array-form manifest', async () => {
    const buffer = await buildZip({
      'screenshots/manifest.json': JSON.stringify([{ filename: 'x.webp', imageHash: 'c'.repeat(64) }]),
    });
    const artifacts = await extractScreenshotArtifactsFromZip(buffer);
    expect(artifacts!.entries).toHaveLength(1);
  });

  it('returns null when there is no screenshots/manifest.json at all', async () => {
    const buffer = await buildZip({ 'main_proof.json': '{}' });
    expect(await extractScreenshotArtifactsFromZip(buffer)).toBeNull();
  });

  it('returns empty entries (not null) for a corrupt manifest so chain-only stripping still surfaces', async () => {
    const buffer = await buildZip({ 'screenshots/manifest.json': '{not json' });
    const artifacts = await extractScreenshotArtifactsFromZip(buffer);
    expect(artifacts).not.toBeNull();
    expect(artifacts!.entries).toEqual([]);
  });
});
