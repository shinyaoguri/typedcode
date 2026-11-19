// @vitest-environment happy-dom
/**
 * 監視中のフォルダの ZIP が変わる・消える (#785)。
 *
 * ZIP から開いたタブのパスは ZIP のフォルダ (`sub.zip` なら `sub/…`) の下にあり、ZIP 自体のパス (`sub.zip`) では
 * 引けない。旧実装は変更・削除の通知をそのパスでタブを引いて処理していたので、ZIP が差し替えられても消されても
 * 古い提出物のタブ・判定が残っていた。ZIP の変更では古い配下を外して開いたときと同じ読み方で取り込み直し、
 * 削除では配下のタブとフォルダ行を外す。
 *
 * 組み立ては `folderStack` (実物のコントローラ群)。フォルダは FSA のハンドルの fake (`FakeFolder`)。
 */

import { sha256HexOfBytes, type StoredEvent } from '@typedcode/shared';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { summarizeTabScreenshots } from '../../services/screenshotSummary.js';
import type { FSAccessFileEntry, VerifyTabState } from '../../types.js';
import { FakeFolder } from './fakeFolder.js';
import { folderStack, stopAllWatching, VALID } from './folderStack.js';
import { mountVerifyIndexHtml } from './verifyDom.js';

const enc = new TextEncoder();
const PROOF_PATH = 'valid_proof.json';
/** `sub.zip` の proof のタブのパス */
const ZIP_PROOF = `sub/${PROOF_PATH}`;
/** 本文だけを書き換えた proof (検証は失敗する)。 */
const TAMPERED = JSON.stringify({ ...JSON.parse(VALID), content: 'TAMPERED CONTENT' });

/** `entries` を詰めた ZIP のバイト列。 */
async function zipBytes(entries: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  return zip.generateAsync({ type: 'uint8array' });
}

/** スクショを同梱する ZIP (`z.png`。manifest どおりの画像)。 */
async function zipWithScreenshots(proof: string): Promise<Uint8Array> {
  const image = enc.encode('bundled image');
  const manifest = JSON.stringify({
    version: '1.0',
    exportedAt: new Date(1_000_000).toISOString(),
    totalScreenshots: 1,
    screenshots: [
      {
        index: 0,
        filename: 'z.png',
        imageHash: await sha256HexOfBytes(image),
        captureType: 'periodic',
        eventSequence: 1,
        timestamp: 10,
        createdAt: 1_000_000,
        displayInfo: {},
        fileSizeBytes: image.length,
      },
    ],
  });
  return zipBytes({ [PROOF_PATH]: proof, 'screenshots/manifest.json': manifest, 'screenshots/z.png': image });
}

/** タブのスクショの集計 (結果パネル・status と同じ関数)。未検査なら undefined。 */
function screenshotSummaryOf(tab: VerifyTabState) {
  const events = (tab.proofData?.proof?.events ?? []) as StoredEvent[];
  return summarizeTabScreenshots({ screenshots: tab.screenshots, events });
}

/** `getFile()` を `release` されるまで止め、渡された中身を返す ZIP のエントリ (読み込みの終わる順を決める)。 */
function heldZipEntry(path: string) {
  const name = path.split('/').pop() ?? path;
  let release!: (bytes: Uint8Array) => void;
  const read = new Promise<Uint8Array>((resolve) => (release = resolve));
  let reading = false;
  const handle = {
    getFile: async () => {
      reading = true;
      return new File([(await read).slice()], name);
    },
  } as unknown as FileSystemFileHandle;
  const entry: FSAccessFileEntry = { handle, path, name, lastModified: Date.now() };
  return { entry, release, reading: () => reading };
}

/** 監視の変更の通知の入口は FolderController の private メンバー。テストからはこれだけを触る。 */
interface FolderInternals {
  handleExternalFileModified(file: FSAccessFileEntry): Promise<void>;
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

describe('a ZIP inside a watched folder changes or disappears (#785)', () => {
  it('reloads the proof opened from a ZIP with the new content and result after the ZIP is overwritten', async () => {
    const s = folderStack();
    const fake = new FakeFolder('submissions', { 'sub.zip': await zipBytes({ [PROOF_PATH]: TAMPERED }) });
    await s.folder.openFolder(fake.handle());
    await s.drain();
    expect(s.tabAt(ZIP_PROOF).verificationResult?.valid).toBe(false);

    fake.write('sub.zip', await zipBytes({ [PROOF_PATH]: VALID }));
    await s.sync();
    await vi.waitFor(() => expect(s.tabAt(ZIP_PROOF).proofData?.content).toBe('ok'));
    await s.drain();

    const tab = s.tabAt(ZIP_PROOF);
    expect(tab.verificationResult?.valid).toBe(true);
    expect(tab.status).not.toBe('error');
    // 古い配下を外してから取り込み直す: 行・タブ・ZIP のフォルダは 1 つずつ
    expect(document.querySelectorAll(`#file-list .file-item[data-filename="${PROOF_PATH}"]`)).toHaveLength(1);
    expect(s.tabManager.getAllTabs()).toHaveLength(1);
    expect(s.sidebar.getAllFolders().filter((folder) => folder.path === 'sub')).toHaveLength(1);
  });

  it('removes the tabs and the folder opened from a ZIP after the ZIP is deleted', async () => {
    const s = folderStack();
    const fake = new FakeFolder('submissions', {
      'sub.zip': await zipBytes({ [PROOF_PATH]: VALID, 'src/valid.js': 'ok' }),
    });
    await s.folder.openFolder(fake.handle());
    expect(s.sidebar.getFileIdByPath('sub/src/valid.js')).toBeDefined();

    fake.remove('sub.zip');
    await s.sync();

    expect(s.sidebar.getFileIdByPath(ZIP_PROOF)).toBeUndefined();
    expect(s.sidebar.getFileIdByPath('sub/src/valid.js')).toBeUndefined();
    expect(s.sidebar.getFolderIdByPath('sub')).toBeUndefined();
    expect(s.sidebar.getFolderIdByPath('sub/src')).toBeUndefined();
    expect(s.tabManager.getAllTabs()).toHaveLength(0);
    expect(document.querySelectorAll('#file-list .file-item')).toHaveLength(0);
  });

  it('leaves the tabs of other ZIPs whose paths share a prefix with the deleted ZIP', async () => {
    const s = folderStack();
    const zip = await zipBytes({ [PROOF_PATH]: VALID });
    const fake = new FakeFolder('submissions', { 'sub.zip': zip, 'sub2.zip': zip, 'nested/sub.zip': zip });
    await s.folder.openFolder(fake.handle());

    fake.remove('sub.zip');
    await s.sync();

    expect(s.sidebar.getFileIdByPath(ZIP_PROOF)).toBeUndefined();
    expect(s.sidebar.getFileIdByPath(`sub2/${PROOF_PATH}`)).toBeDefined();
    expect(s.sidebar.getFileIdByPath(`nested/sub/${PROOF_PATH}`)).toBeDefined();
    expect(s.tabManager.getAllTabs()).toHaveLength(2);
  });

  it("keeps the bundled screenshots of a ZIP that replaced one without screenshots after the folder's screenshots change", async () => {
    const s = folderStack();
    // フォルダに screenshots/ があり、ZIP はスクショを同梱しない (フォルダのスクショを渡す。#742)
    const fake = new FakeFolder('submissions', {
      'screenshots/manifest.json': JSON.stringify({ version: '1.0', totalScreenshots: 0, screenshots: [] }),
      'sub.zip': await zipBytes({ [PROOF_PATH]: VALID }),
    });
    await s.folder.openFolder(fake.handle());
    expect(s.tabAt(ZIP_PROOF).screenshots).toEqual([]);

    fake.write('sub.zip', await zipWithScreenshots(TAMPERED));
    await s.sync();
    await vi.waitFor(() => expect(s.tabAt(ZIP_PROOF).proofData?.content).toBe('TAMPERED CONTENT'));
    const id = s.tabAt(ZIP_PROOF).id;

    // フォルダのスクショが変わっても、同梱のスクショを使う新しい ZIP の proof は取り込み直さない
    // (外した ZIP の proof が読み直しの対象に残っていると、古い内容とフォルダのスクショで上書きされる)
    fake.write(
      'screenshots/manifest.json',
      JSON.stringify({ version: '1.0', totalScreenshots: 0, screenshots: [], x: 1 })
    );
    await s.sync();

    const tab = s.tabAt(ZIP_PROOF);
    expect(tab.proofData?.content).toBe('TAMPERED CONTENT');
    expect(tab.screenshots?.map((shot) => shot.filename)).toEqual(['z.png']);
    expect(s.enqueued.filter((queued) => queued === id)).toHaveLength(1);
    expect(screenshotSummaryOf(tab)).toMatchObject({ total: 1 });
  });

  it('keeps the newer ZIP content when an older reload of the same ZIP finishes after a newer one', async () => {
    const s = folderStack();
    const initial = JSON.stringify({ ...JSON.parse(VALID), content: 'initial' });
    const fake = new FakeFolder('submissions', { 'sub.zip': await zipBytes({ [PROOF_PATH]: initial }) });
    await s.folder.openFolder(fake.handle());
    const folder = s.folder as unknown as FolderInternals;
    const older = heldZipEntry('sub.zip');
    const newer = heldZipEntry('sub.zip');

    const olderLoad = folder.handleExternalFileModified(older.entry);
    await vi.waitFor(() => expect(older.reading()).toBe(true));
    const newerLoad = folder.handleExternalFileModified(newer.entry);
    newer.release(await zipBytes({ [PROOF_PATH]: VALID }));
    await newerLoad;
    older.release(await zipBytes({ [PROOF_PATH]: TAMPERED }));
    await olderLoad;

    expect(s.tabAt(ZIP_PROOF).proofData?.content).toBe('ok');
    expect(s.tabManager.getAllTabs()).toHaveLength(1);
  });
});
