/**
 * スクリーンショット検証の ZIP 経路 / フォルダ経路の結論一致 (#212)。
 *
 * manifest と画像は未署名なのでセットで差し替えられる。真正な記録は改ざん不能な
 * チェーンに焼かれた `screenshotCapture.imageHash` だけ — フォルダ経路がその集合を
 * 渡し忘れると「ZIP で開くと改竄・フォルダで開くと緑」という提出物依存の結論になる。
 * 同じ材料から同じ結論が出ることをここで固定する。
 */

import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { sha256HexOfBytes } from '@typedcode/shared';
import { ZipFileProcessor } from '../ZipFileProcessor.js';
import { collectFolderChainImageHashes, loadFolderScreenshots } from '../folderScreenshotLoader.js';
import type { FSAccessFileEntry, VerifyScreenshot } from '../../types.js';

const enc = new TextEncoder();

/** チェーンに 1 枚のスクショが焼かれた proof。 */
function proofJson(chainImageHash: string): string {
  return JSON.stringify({
    content: '',
    language: 'typescript',
    proof: {
      events: [
        { sequence: 0, type: 'humanAttestation', timestamp: 0, data: {} },
        { sequence: 1, type: 'screenshotCapture', timestamp: 10, data: { imageHash: chainImageHash } },
      ],
    },
  });
}

/** manifest が 1 枚だけ指す export。`imageHash` は攻撃者が差し替えられる。 */
function manifestJson(imageHash: string): string {
  return JSON.stringify({
    version: '1.0',
    exportedAt: new Date(1_000_000).toISOString(),
    totalScreenshots: 1,
    screenshots: [
      {
        index: 0,
        filename: 'shot-0.webp',
        imageHash,
        captureType: 'periodic',
        eventSequence: 1,
        timestamp: 10,
        createdAt: 1_000_000,
        displayInfo: {},
        fileSizeBytes: 7,
      },
    ],
  });
}

function fakeFile(
  bytes: Uint8Array,
  type: string
): { type: string; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> } {
  return {
    type,
    arrayBuffer: async () => bytes.slice().buffer,
    text: async () => new TextDecoder().decode(bytes),
  };
}

/** `screenshots/` だけを持つ FSA ディレクトリハンドルの最小 fake。 */
function fakeRootHandle(screenshotsFolder: Record<string, Uint8Array> | null): FileSystemDirectoryHandle {
  return {
    getDirectoryHandle: async (name: string) => {
      if (name !== 'screenshots' || screenshotsFolder === null) throw new Error('NotFoundError');
      return {
        getFileHandle: async (filename: string) => {
          const bytes = screenshotsFolder[filename];
          if (!bytes) throw new Error('NotFoundError');
          return {
            getFile: async () => fakeFile(bytes, filename.endsWith('.json') ? 'application/json' : 'image/webp'),
          };
        },
      };
    },
  } as unknown as FileSystemDirectoryHandle;
}

function fakeProofEntry(name: string, json: string): FSAccessFileEntry {
  return {
    name,
    path: name,
    lastModified: 0,
    handle: { getFile: async () => fakeFile(enc.encode(json), 'application/json') },
  } as unknown as FSAccessFileEntry;
}

/** ZIP 経路: エクスポート ZIP をそのまま読み込んだときのスクショ判定。 */
async function verifyViaZip(proof: string, manifest: string, image: Uint8Array): Promise<VerifyScreenshot[]> {
  const zip = new JSZip();
  zip.file('main_proof.json', proof);
  zip.file('screenshots/manifest.json', manifest);
  zip.file('screenshots/shot-0.webp', image);
  const buffer = await zip.generateAsync({ type: 'arraybuffer' });

  const result = await new ZipFileProcessor().process(new File([buffer], 'export.zip'));
  return result.screenshots ?? [];
}

/** フォルダ経路: 同じ ZIP を展開したフォルダを読み込んだときのスクショ判定。 */
async function verifyViaFolder(proof: string, manifest: string, image: Uint8Array): Promise<VerifyScreenshot[]> {
  const files = [fakeProofEntry('main_proof.json', proof)];
  const chainImageHashes = await collectFolderChainImageHashes(files);
  const root = fakeRootHandle({ 'manifest.json': enc.encode(manifest), 'shot-0.webp': image });

  const { screenshots } = await loadFolderScreenshots(root, chainImageHashes);
  return screenshots;
}

describe('screenshot verification parity between the ZIP and folder paths', () => {
  it('flags a manifest+image pair swap as tampered on the folder path just like the ZIP path', async () => {
    // 攻撃: 画像を差し替え、未署名の manifest の imageHash も差し替えて辻褄を合わせる。
    // 画像と manifest は自己整合するので、チェーンと突き合わせない限り検出できない。
    const original = enc.encode('original');
    const attacker = enc.encode('attacker');
    const proof = proofJson(await sha256HexOfBytes(original));
    const manifest = manifestJson(await sha256HexOfBytes(attacker));

    const viaZip = await verifyViaZip(proof, manifest, attacker);
    const viaFolder = await verifyViaFolder(proof, manifest, attacker);

    expect(viaZip[0]?.tampered).toBe(true);
    expect(viaFolder[0]?.tampered).toBe(true);
  });

  it('keeps an untampered export verified on both paths', async () => {
    const image = enc.encode('original');
    const hash = await sha256HexOfBytes(image);
    const proof = proofJson(hash);
    const manifest = manifestJson(hash);

    const viaZip = await verifyViaZip(proof, manifest, image);
    const viaFolder = await verifyViaFolder(proof, manifest, image);

    expect(viaZip[0]).toMatchObject({ verified: true, tampered: false, missing: false });
    expect(viaFolder[0]).toMatchObject({ verified: true, tampered: false, missing: false });
  });
});

describe('collectFolderChainImageHashes', () => {
  it('collects screenshot hashes from every proof in the folder', async () => {
    const hashA = 'a'.repeat(64);
    const hashB = 'b'.repeat(64);
    const files = [fakeProofEntry('a_proof.json', proofJson(hashA)), fakeProofEntry('b_proof.json', proofJson(hashB))];

    expect(await collectFolderChainImageHashes(files)).toEqual(new Set([hashA, hashB]));
  });

  it('ignores files that are not proofs instead of failing the whole folder', async () => {
    const files = [
      fakeProofEntry('tsconfig.json', '{"compilerOptions":{}}'),
      fakeProofEntry('broken.json', 'not json'),
      fakeProofEntry('main.ts', 'const x = 1;'),
    ];

    expect(await collectFolderChainImageHashes(files)).toEqual(new Set());
  });
});

describe('loadFolderScreenshots', () => {
  it('reports zero screenshots (not "unavailable") when the folder has no screenshots directory', async () => {
    // 剥ぎ取りを chainOnly で検出できるように、コンテナを受け取った事実は保つ。
    const result = await loadFolderScreenshots(fakeRootHandle(null), new Set(['a'.repeat(64)]));

    expect(result.screenshots).toEqual([]);
    expect(result.screenshotService).toBeUndefined();
  });

  it('survives a manifest without a screenshots field instead of silently dropping the folder', async () => {
    const root = fakeRootHandle({ 'manifest.json': enc.encode('{"version":"1.0"}') });

    await expect(loadFolderScreenshots(root, new Set())).resolves.toEqual({ screenshots: [] });
  });

  it('marks a manifest entry whose image file is absent as missing', async () => {
    const image = enc.encode('original');
    const hash = await sha256HexOfBytes(image);
    const root = fakeRootHandle({ 'manifest.json': enc.encode(manifestJson(hash)) });

    const { screenshots } = await loadFolderScreenshots(root, new Set([hash]));

    expect(screenshots).toHaveLength(1);
    expect(screenshots[0]).toMatchObject({ missing: true, verified: false });
  });
});
