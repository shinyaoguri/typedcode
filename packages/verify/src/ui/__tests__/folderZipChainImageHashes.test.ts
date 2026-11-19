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
