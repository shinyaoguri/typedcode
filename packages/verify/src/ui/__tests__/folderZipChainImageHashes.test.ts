// @vitest-environment happy-dom
/**
 * フォルダのスクショのチェーン裏付け (#212) に、フォルダ内の ZIP に入った proof のチェーンも数える (#786)。
 *
 * フォルダのスクショは、フォルダ内の全 proof のチェーンの imageHash 集合で判定する。旧実装はその集合を
 * フォルダ直下の `*.json` だけから作り、スクショを同梱しない ZIP の proof (フォルダのスクショを受け取る。#742)
 * のチェーンを数えていなかった。同じ proof を単独の `*_proof.json` として置いたときと判定が食い違う:
 *
 * - 集合が空 (ほかに proof が無い) → チェーン裏付けが対象外に退化し、manifest と画像をセットで差し替えた改竄を見逃す
 * - 集合がほかの proof のハッシュだけ → ZIP の proof 自身が撮った真正な画像が「チェーンに無い」= 改竄と出る
 *
 * 組み立ては `folderStack` (実物のコントローラ群)。比べるのはタブのスクショの集計 (結果パネル・status と同じ関数)。
 * proof のチェーン自体は検証に通らない (イベントを足している) が、スクショの判定はチェーンの検証と独立に決まる。
 */

import { sha256HexOfBytes, type StoredEvent } from '@typedcode/shared';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { summarizeTabScreenshots } from '../../services/screenshotSummary.js';
import type { VerifyTabState } from '../../types.js';
import { FakeFolder } from './fakeFolder.js';
import { folderStack, stopAllWatching, VALID } from './folderStack.js';
import { mountVerifyIndexHtml } from './verifyDom.js';

const enc = new TextEncoder();
/** 提出者が撮った画像 (チェーンに記録がある) */
const GENUINE = enc.encode('genuine image');
/** 差し替えた画像 (チェーンに記録が無い。manifest もこれに合わせて書き換える) */
const FORGED = enc.encode('forged image');
/** 別の proof が撮った画像 */
const OTHER = enc.encode('other image');

/** チェーンに `imageHash` の screenshotCapture を記録した proof (VALID にイベントを 1 つ足したもの)。 */
async function proofCapturing(image: Uint8Array): Promise<string> {
  const proof = JSON.parse(VALID);
  const events = proof.proof.events as StoredEvent[];
  events.push({
    ...events[events.length - 1],
    sequence: events.length,
    type: 'screenshotCapture',
    data: { imageHash: await sha256HexOfBytes(image) },
  } as unknown as StoredEvent);
  return JSON.stringify(proof);
}

/** `screenshots/manifest.json` と画像。manifest の imageHash は画像の実ハッシュ (manifest と画像は揃っている)。 */
async function screenshotsDir(images: Record<string, Uint8Array>): Promise<Record<string, string | Uint8Array>> {
  const entries = await Promise.all(
    Object.entries(images).map(async ([filename, bytes], index) => ({
      index,
      filename,
      imageHash: await sha256HexOfBytes(bytes),
      captureType: 'periodic',
      eventSequence: 1,
      timestamp: 10 + index,
      createdAt: 1_000_000,
      displayInfo: {},
      fileSizeBytes: bytes.length,
    }))
  );
  const files: Record<string, string | Uint8Array> = {
    'screenshots/manifest.json': JSON.stringify({
      version: '1.0',
      exportedAt: new Date(1_000_000).toISOString(),
      totalScreenshots: entries.length,
      screenshots: entries,
    }),
  };
  for (const [name, bytes] of Object.entries(images)) files[`screenshots/${name}`] = bytes;
  return files;
}

async function zipBytes(entries: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  return zip.generateAsync({ type: 'uint8array' });
}

/** タブのスクショの集計。未検査なら undefined。 */
function screenshotSummaryOf(tab: VerifyTabState) {
  const events = (tab.proofData?.proof?.events ?? []) as StoredEvent[];
  return summarizeTabScreenshots({ screenshots: tab.screenshots, events });
}

/**
 * `proof` を ZIP (スクショを同梱しない `sub.zip`) に入れたフォルダと、単独の `sub_proof.json` として置いた
 * フォルダを開き、その proof のスクショの集計を返す。`extra` は両方のフォルダに同じく置くファイル。
 */
async function openBothWays(proof: string, extra: Record<string, string | Uint8Array>) {
  const viaZip = folderStack();
  await viaZip.folder.openFolder(
    new FakeFolder('submission', { ...extra, 'sub.zip': await zipBytes({ 'sub_proof.json': proof }) }).handle()
  );
  const zip = screenshotSummaryOf(viaZip.tabAt('sub/sub_proof.json'));

  // 画面 (Sidebar の DOM) は 1 つなので、組み立て直してから開く
  stopAllWatching();
  mountVerifyIndexHtml();
  const standalone = folderStack();
  await standalone.folder.openFolder(new FakeFolder('submission', { ...extra, 'sub_proof.json': proof }).handle());
  return { zip, standalone: screenshotSummaryOf(standalone.tabAt('sub_proof.json')) };
}

beforeEach(() => {
  mountVerifyIndexHtml();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  stopAllWatching();
});

describe("chain backing of the folder's screenshots for the proof of a ZIP without screenshots (#786)", () => {
  it('reports a screenshot whose manifest and image were replaced together as tampered for the proof of a ZIP, as for the same proof placed as a standalone file', async () => {
    const proof = await proofCapturing(GENUINE);
    const { zip, standalone } = await openBothWays(proof, await screenshotsDir({ 'a.png': FORGED }));

    expect(standalone).toMatchObject({ total: 1, tampered: 1 });
    expect(zip).toEqual(standalone);
  });

  it("does not report the proof's own screenshot as tampered for the proof of a ZIP when the folder holds another proof, as for the same proof placed as a standalone file", async () => {
    const proof = await proofCapturing(GENUINE);
    const { zip, standalone } = await openBothWays(proof, {
      ...(await screenshotsDir({ 'a.png': GENUINE })),
      'other_proof.json': await proofCapturing(OTHER),
    });

    expect(standalone).toMatchObject({ total: 1, tampered: 0 });
    expect(zip).toEqual(standalone);
  });

  it('keeps preferring the screenshots bundled in a ZIP over the folder screenshots for its proof', async () => {
    const proof = await proofCapturing(GENUINE);
    const s = folderStack();
    await s.folder.openFolder(
      new FakeFolder('submission', {
        ...(await screenshotsDir({ 'a.png': FORGED })),
        'sub.zip': await zipBytes({ 'sub_proof.json': proof, ...(await screenshotsDir({ 'z.png': GENUINE })) }),
      }).handle()
    );

    const tab = s.tabAt('sub/sub_proof.json');
    expect(tab.screenshots?.map((shot) => shot.filename)).toEqual(['z.png']);
    expect(screenshotSummaryOf(tab)).toMatchObject({ total: 1, tampered: 0 });
  });
});

/**
 * 監視中にフォルダ内の ZIP が足される・変わる・消える (#834)。ZIP の proof もチェーン側の imageHash 集合の材料
 * (#786) なので、集合を取り直してフォルダのスクショを読み直す。期待は「その状態のフォルダを開き直したときと同じ判定」。
 */
describe("chain backing of the folder's screenshots while a ZIP in the watched folder changes (#834)", () => {
  /** `files` のフォルダを新しく開いたときの、`path` のタブのスクショの集計 */
  async function summaryOnOpen(files: Record<string, string | Uint8Array>, path: string) {
    stopAllWatching();
    mountVerifyIndexHtml();
    const fresh = folderStack();
    await fresh.folder.openFolder(new FakeFolder('submission', files).handle());
    return screenshotSummaryOf(fresh.tabAt(path));
  }

  /** 監視を 1 回回し、ZIP の取り込みとスクショの読み直しが落ち着くまで待つ */
  async function syncZip(s: ReturnType<typeof folderStack>, settled: () => void): Promise<void> {
    await s.sync();
    await vi.waitFor(settled);
    await s.folder.whenScreenshotsResynced();
  }

  it.each([
    ['the folder holds no other proof (a forged screenshot)', FORGED, {}],
    [
      'the folder holds another proof (the genuine screenshot of the ZIP proof)',
      GENUINE,
      { 'other_proof.json': 'OTHER' },
    ],
  ] as const)(
    'gives the proof of a ZIP without screenshots added while watching the same screenshot verdict as opening the folder with it when %s',
    async (_case, image, extra) => {
      const base: Record<string, string | Uint8Array> = { ...(await screenshotsDir({ 'a.png': image })) };
      if ('other_proof.json' in extra) base['other_proof.json'] = await proofCapturing(OTHER);
      const zip = await zipBytes({ 'sub_proof.json': await proofCapturing(GENUINE) });

      const s = folderStack();
      const fake = new FakeFolder('submission', base);
      await s.folder.openFolder(fake.handle());
      fake.write('sub.zip', zip);
      await syncZip(s, () => expect(() => s.tabAt('sub/sub_proof.json')).not.toThrow());
      const watched = screenshotSummaryOf(s.tabAt('sub/sub_proof.json'));

      const opened = await summaryOnOpen({ ...base, 'sub.zip': zip }, 'sub/sub_proof.json');
      expect(watched).toEqual(opened);
    }
  );

  it('gives the proof of a ZIP reloaded while the screenshots are being re-read the verdict of the new chain hashes, as when opening the folder with it', async () => {
    const files: Record<string, string | Uint8Array> = {
      ...(await screenshotsDir({ 'a.png': GENUINE })),
      'z_other_proof.json': await proofCapturing(OTHER),
      'sub.zip': await zipBytes({ 'sub_proof.json': await proofCapturing(FORGED) }),
    };
    const s = folderStack();
    const fake = new FakeFolder('submission', files);
    await s.folder.openFolder(fake.handle());
    expect(screenshotSummaryOf(s.tabAt('sub/sub_proof.json'))).toMatchObject({ total: 1, tampered: 1 });

    // 読み直しは ZIP の proof (先に取り込んだ) を控えてから、単独の proof (z_ で後に並ぶ) を読む。
    // 監視の 1 回の走査での getFile(): ZIP は 走査 → 取り込み → 読み直しの一覧 → 集合、単独の proof は
    // 走査 → 読み直しの一覧 → 集合 → 取り込み直し。ZIP の取り込みを、読み直しが単独の proof を読み直している
    // 途中まで止め、取り込み (タブ ID が変わる) を読み直しの確定の前・ZIP の proof を控えた後に終わらせる
    const zipCalls = fake.getFileCount('sub.zip');
    const otherCalls = fake.getFileCount('z_other_proof.json');
    let releaseImport!: () => void;
    let releaseReread!: () => void;
    const importGate = new Promise<void>((resolve) => (releaseImport = resolve));
    const rereadGate = new Promise<void>((resolve) => (releaseReread = resolve));
    let rereading = false;
    fake.beforeGetFile = async (path, call) => {
      if (path === 'sub.zip' && call === zipCalls + 2) await importGate;
      if (path === 'z_other_proof.json' && call === otherCalls + 4) {
        rereading = true;
        await rereadGate;
      }
    };
    const replaced = await zipBytes({ 'sub_proof.json': await proofCapturing(GENUINE) });
    const before = s.tabAt('sub/sub_proof.json').id;
    fake.write('sub.zip', replaced);
    const synced = s.sync();
    await vi.waitFor(() => expect(rereading).toBe(true));
    releaseImport();
    await vi.waitFor(() => expect(s.tabAt('sub/sub_proof.json').id).not.toBe(before));
    releaseReread();
    await synced;
    await s.folder.whenScreenshotsResynced();

    const watched = screenshotSummaryOf(s.tabAt('sub/sub_proof.json'));
    expect(watched).toEqual(await summaryOnOpen({ ...files, 'sub.zip': replaced }, 'sub/sub_proof.json'));
    expect(watched).toMatchObject({ total: 1, tampered: 0 });
  });

  /** a.png を撮ったのは ZIP の proof だけ。単独の other_proof.json もフォルダのスクショを受け取る */
  async function folderWithZipBackingTheScreenshot() {
    return {
      ...(await screenshotsDir({ 'a.png': GENUINE })),
      'other_proof.json': await proofCapturing(OTHER),
      'sub.zip': await zipBytes({ 'sub_proof.json': await proofCapturing(GENUINE) }),
    };
  }

  it('gives a standalone proof the same screenshot verdict as reopening the folder after the ZIP is overwritten with another proof', async () => {
    const files = await folderWithZipBackingTheScreenshot();
    const s = folderStack();
    const fake = new FakeFolder('submission', files);
    await s.folder.openFolder(fake.handle());
    expect(screenshotSummaryOf(s.tabAt('other_proof.json'))).toMatchObject({ total: 1, tampered: 0 });

    const replaced = await zipBytes({ 'sub_proof.json': await proofCapturing(OTHER) });
    const before = s.tabAt('sub/sub_proof.json').id;
    fake.write('sub.zip', replaced);
    await syncZip(s, () => expect(s.tabAt('sub/sub_proof.json').id).not.toBe(before));
    const watched = screenshotSummaryOf(s.tabAt('other_proof.json'));

    expect(watched).toEqual(await summaryOnOpen({ ...files, 'sub.zip': replaced }, 'other_proof.json'));
    expect(watched).toMatchObject({ total: 1, tampered: 1 });
  });

  it('gives a standalone proof the same screenshot verdict as reopening the folder after the ZIP is deleted', async () => {
    const files = await folderWithZipBackingTheScreenshot();
    const s = folderStack();
    const fake = new FakeFolder('submission', files);
    await s.folder.openFolder(fake.handle());

    fake.remove('sub.zip');
    await syncZip(s, () => expect(s.sidebar.getFileIdByPath('sub/sub_proof.json')).toBeUndefined());
    const watched = screenshotSummaryOf(s.tabAt('other_proof.json'));

    const { 'sub.zip': _removed, ...rest } = files;
    expect(watched).toEqual(await summaryOnOpen(rest, 'other_proof.json'));
    expect(watched).toMatchObject({ total: 1, tampered: 1 });
  });
});
