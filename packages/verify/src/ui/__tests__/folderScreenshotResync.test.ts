// @vitest-environment happy-dom
/**
 * FSA フォルダの監視で `screenshots/` が変わったら、そのフォルダの proof のスクショ検証を取り直す (#703)。
 *
 * スクショはフォルダ (コンテナ) が proof に渡す検証入力。旧実装はフォルダを開いたときに一度だけ読み、
 * 監視で画像や manifest が変わっても読み直さなかった (画像タブは新しい画像・結果パネルは古い画像の判定)。
 * 監視中に追加した proof にはスクショを渡さず「未検査」(undefined) にしていた (不変条件 8 に反する)。
 *
 * 組み立ては `folderStack` (実物のコントローラ群。検証は `runProofVerification` を実際に呼ぶ)。フォルダは
 * FSA のハンドルの fake (`FakeFolder`) で、外での書き換えを `write` / `remove` で表して監視を 1 回ずつ回す。
 */

import { sha256HexOfBytes, type StoredEvent } from '@typedcode/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { summarizeTabScreenshots } from '../../services/screenshotSummary.js';
import { TrustCalculator } from '../../services/TrustCalculator.js';
import type { VerifyTabState } from '../../types.js';
import { FakeFolder } from './fakeFolder.js';
import { folderStack, stopAllWatching, VALID } from './folderStack.js';
import { mountVerifyIndexHtml } from './verifyDom.js';

const enc = new TextEncoder();
const PROOF_PATH = 'valid_proof.json';
const ORIGINAL = enc.encode('original image');
const REPLACED = enc.encode('replaced image');
/** 本文だけを書き換えた proof (検証は失敗する)。 */
const TAMPERED = JSON.stringify({ ...JSON.parse(VALID), content: 'TAMPERED CONTENT' });

/** `screenshots/manifest.json`。各画像の imageHash は manifest に書いた値 (画像の実ハッシュと突き合わされる)。 */
async function manifestFor(images: Record<string, Uint8Array>): Promise<string> {
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
  return JSON.stringify({
    version: '1.0',
    exportedAt: new Date(1_000_000).toISOString(),
    totalScreenshots: entries.length,
    screenshots: entries,
  });
}

/** proof と、manifest どおりの画像を持つ `screenshots/` を置いたフォルダ。 */
async function exportFolder(images: Record<string, Uint8Array>, extra: Record<string, string> = {}) {
  const files: Record<string, string | Uint8Array> = {
    [PROOF_PATH]: VALID,
    'screenshots/manifest.json': await manifestFor(images),
    ...extra,
  };
  for (const [name, bytes] of Object.entries(images)) files[`screenshots/${name}`] = bytes;
  return new FakeFolder('submission', files);
}

/** タブのスクショの集計 (結果パネル・status と同じ関数)。未検査なら undefined。 */
function screenshotSummaryOf(tab: VerifyTabState) {
  const events = (tab.proofData?.proof?.events ?? []) as StoredEvent[];
  return summarizeTabScreenshots({ screenshots: tab.screenshots, events });
}

/** 信頼バッジの issue (`#trust-issues-list` の data-component / data-severity の元)。 */
function trustIssuesOf(tab: VerifyTabState) {
  return TrustCalculator.calculate(tab.verificationResult, screenshotSummaryOf(tab)).issues.map((issue) => ({
    component: issue.component,
    severity: issue.severity,
  }));
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

describe('folder screenshots re-checked while watching (#703)', () => {
  it('re-verifies the proof and reports screenshot tampering after a screenshot image is replaced', async () => {
    const s = folderStack();
    const fake = await exportFolder({ 'a.png': ORIGINAL });
    await s.folder.openFolder(fake.handle());
    await s.drain();
    expect(s.tabAt(PROOF_PATH).status).not.toBe('error');
    expect(screenshotSummaryOf(s.tabAt(PROOF_PATH))?.tampered).toBe(0);

    fake.write('screenshots/a.png', REPLACED);
    await s.sync();
    await s.drain();

    const tab = s.tabAt(PROOF_PATH);
    expect(tab.status).toBe('error');
    expect(screenshotSummaryOf(tab)?.tampered).toBe(1);
    expect(trustIssuesOf(tab)).toContainEqual({ component: 'screenshots', severity: 'error' });
  });

  it('re-verifies the proof once even when several screenshot files change in one scan', async () => {
    const s = folderStack();
    const fake = await exportFolder({ 'a.png': ORIGINAL, 'b.png': ORIGINAL });
    await s.folder.openFolder(fake.handle());
    await s.drain();
    const id = s.tabAt(PROOF_PATH).id;
    expect(s.enqueued).toEqual([id]);

    fake.write('screenshots/a.png', REPLACED);
    fake.write('screenshots/b.png', REPLACED);
    fake.write('screenshots/manifest.json', await manifestFor({ 'a.png': ORIGINAL, 'b.png': REPLACED }));
    await s.sync();

    expect(s.enqueued).toEqual([id, id]);
    await s.drain();
    expect(screenshotSummaryOf(s.tabAt(PROOF_PATH))).toMatchObject({ total: 2, tampered: 1 });
  });

  it('keeps the proof, its content and the source match as one snapshot of the files on disk after the screenshots change', async () => {
    const s = folderStack();
    const fake = await exportFolder({ 'a.png': ORIGINAL }, { 'valid.js': 'ok' });
    await s.folder.openFolder(fake.handle());
    await s.drain();
    const before = s.tabAt(PROOF_PATH);
    expect(before.associatedSourceMismatch).toBeUndefined();

    // 同じ走査で proof も書き換わる: 取り込み直しはディスクの proof を読み、古い本文を使い回さない
    fake.write('screenshots/a.png', REPLACED);
    fake.write(PROOF_PATH, TAMPERED);
    await s.sync();
    await vi.waitFor(() => expect(s.tabAt(PROOF_PATH).proofData?.content).toBe('TAMPERED CONTENT'));
    await s.drain();

    const after = s.tabAt(PROOF_PATH);
    expect(after.id).toBe(before.id);
    expect(after.proofData).toEqual(JSON.parse(TAMPERED));
    expect(after.verificationResult?.valid).toBe(false);
    expect(after.associatedSourceMismatch).toMatchObject({ kind: 'mismatch', severity: 'error' });
    expect(screenshotSummaryOf(after)?.tampered).toBe(1);
  });

  it("checks a proof added while watching against the folder's screenshots", async () => {
    const s = folderStack();
    const fake = await exportFolder({ 'a.png': ORIGINAL });
    await s.folder.openFolder(fake.handle());
    await s.drain();
    const firstId = s.tabAt(PROOF_PATH).id;

    fake.write('added_proof.json', VALID);
    await s.sync();
    await vi.waitFor(() => expect(s.waiting.size).toBe(1));

    const added = s.tabAt('added_proof.json');
    expect(added.screenshots?.map((shot) => shot.filename)).toEqual(['a.png']);
    // スクショの判定が変わらない proof の追加では、ほかの proof を検証し直さない
    expect(s.enqueued.filter((id) => id === firstId)).toHaveLength(1);
  });

  it('checks a proof that appears together with screenshots/ against the reloaded screenshots even when the screenshot reload finishes before the proof is read', async () => {
    const s = folderStack();
    const fake = new FakeFolder('submission', { 'readme.txt': 'hello' });
    await s.folder.openFolder(fake.handle());

    // 提出物一式を後から置く: proof と screenshots/ が同じ走査で現れる。proof の取り込み (監視の走査の後の
    // 2 回目の getFile) だけを、スクショの読み直しが終わるまで止める
    let release!: () => void;
    const proofReadReleased = new Promise<void>((r) => (release = r));
    fake.beforeGetFile = (path, call) => (path === 'added_proof.json' && call === 2 ? proofReadReleased : undefined);
    fake.write('added_proof.json', VALID);
    fake.write('screenshots/manifest.json', await manifestFor({ 'a.png': ORIGINAL }));
    fake.write('screenshots/a.png', ORIGINAL);
    await s.sync();
    expect(() => s.tabAt('added_proof.json')).toThrow();

    release();
    await vi.waitFor(() => expect(() => s.tabAt('added_proof.json')).not.toThrow());
    await s.folder.whenScreenshotsResynced();
    await s.drain();

    const added = s.tabAt('added_proof.json');
    expect(added.screenshots?.map((shot) => shot.filename)).toEqual(['a.png']);
    expect(screenshotSummaryOf(added)).toMatchObject({ total: 1, tampered: 0, missing: 0 });
  });

  // 1 回の走査で、変わったファイルは 監視の走査 (+1)・タブの取り込み直し (+2)・読み直しの一覧 (+3)・
  // 読み直しのスクショの読み込み (+4) の順に読まれる。そのうち 1 回だけを一時的な読み取りの失敗にする
  it.each([
    ['the folder listing', 'screenshots/a.png', 3],
    ['the screenshot image', 'screenshots/a.png', 4],
    ['the manifest', 'screenshots/manifest.json', 4],
  ])('commits nothing when %s cannot be read during the screenshot reload', async (_what, failingPath, offset) => {
    const s = folderStack();
    const fake = await exportFolder({ 'a.png': ORIGINAL });
    await s.folder.openFolder(fake.handle());
    await s.drain();
    const id = s.tabAt(PROOF_PATH).id;

    if (failingPath === 'screenshots/a.png') fake.write('screenshots/a.png', REPLACED);
    else fake.write('screenshots/manifest.json', await manifestFor({ 'a.png': REPLACED }));
    const failAt = fake.getFileCount(failingPath) + offset;
    let failures = 0;
    fake.beforeGetFile = (path, call) => {
      if (path !== failingPath || call !== failAt) return;
      failures++;
      throw new DOMException('busy', 'NotReadableError');
    };
    await s.sync();

    expect(failures).toBe(1);
    expect(s.enqueued).toEqual([id]);
    const tab = s.tabAt(PROOF_PATH);
    expect(tab.status).not.toBe('error');
    expect(screenshotSummaryOf(tab)).toMatchObject({ total: 1, tampered: 0, missing: 0 });
  });

  it('reloads the screenshots on the next successful watch scan after a failed reload, without another change notification', async () => {
    const s = folderStack();
    const fake = await exportFolder({ 'a.png': ORIGINAL });
    await s.folder.openFolder(fake.handle());
    await s.drain();
    const id = s.tabAt(PROOF_PATH).id;

    fake.write('screenshots/a.png', REPLACED);
    const failAt = fake.getFileCount('screenshots/a.png') + 4;
    fake.beforeGetFile = (path, call) => {
      if (path === 'screenshots/a.png' && call === failAt) throw new DOMException('busy', 'NotReadableError');
    };
    await s.sync();
    expect(s.enqueued).toEqual([id]);

    // 読めるようになった。ファイルは変わっていないので変化の通知は出ない
    await s.sync();
    await s.drain();

    expect(s.enqueued).toEqual([id, id]);
    const tab = s.tabAt(PROOF_PATH);
    expect(tab.status).toBe('error');
    expect(screenshotSummaryOf(tab)?.tampered).toBe(1);
  });

  it('treats a screenshots directory removed while watching as zero screenshots, not as a read failure', async () => {
    const s = folderStack();
    const fake = await exportFolder({ 'a.png': ORIGINAL });
    await s.folder.openFolder(fake.handle());
    await s.drain();
    const id = s.tabAt(PROOF_PATH).id;

    fake.remove('screenshots/a.png');
    fake.remove('screenshots/manifest.json');
    await s.sync();

    expect(s.enqueued).toEqual([id, id]);
    expect(s.tabAt(PROOF_PATH).screenshots).toEqual([]);
  });

  it('checks a proof added while watching as zero screenshots when the folder has no screenshots directory', async () => {
    const s = folderStack();
    const fake = new FakeFolder('submission', { [PROOF_PATH]: VALID });
    await s.folder.openFolder(fake.handle());

    fake.write('added_proof.json', VALID);
    await s.sync();
    await vi.waitFor(() => expect(s.waiting.size).toBe(2));

    expect(s.tabAt('added_proof.json').screenshots).toEqual([]);
  });

  it('shows a screenshot image added while watching as an image tab', async () => {
    const s = folderStack();
    const fake = await exportFolder({ 'a.png': ORIGINAL });
    await s.folder.openFolder(fake.handle());

    fake.write('screenshots/b.png', REPLACED);
    await s.sync();
    await vi.waitFor(() => expect(() => s.tabAt('screenshots/b.png')).not.toThrow());

    const tab = s.tabAt('screenshots/b.png');
    expect(tab.isImage).toBe(true);
    expect(tab.isPlaintext).toBeFalsy();
  });
});
