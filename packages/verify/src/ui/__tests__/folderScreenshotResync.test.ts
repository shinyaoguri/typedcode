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
