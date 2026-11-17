import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { EditorApp, readProofJson } from './helpers/app.js';
import { runVerifyCliWithVerdicts } from './helpers/verifyCli.js';
import {
  VerifyWebApp,
  expectWebCliParity,
  typeAndExport,
  type VerifyFileStatus,
  type VerifyFolderFile,
} from './helpers/verifyWeb.js';

/**
 * verify Web の「フォルダを開く」で監視中の proof を外部で書き換えると、開いているタブの判定・本文が
 * 新しい proof のものになる (#695)。旧実装は status と結果だけを初期化して新しい proof を検証に回し、
 * 古い本文と新しい判定を合成して表示していた。
 *
 * フォルダは OPFS の本物のディレクトリ (`openFolder`)。書き換えも OPFS のファイルを上書きするだけで、
 * 検出は verify のフォルダ監視 (3 秒間隔のポーリング) に任せる。判定は data-* の状態契約で読み、
 * 書き換え後の proof に対する verify-cli の判定と突き合わせる (不変条件 6)。本文は結果パネルの
 * コードプレビュー (イベントの再生) に、改ざんで差し込んだ印が出ているかで見る。検証は fast (不変条件 4)。
 *
 * `screenshots/` の画像を書き換えたときは、同じフォルダの proof のスクショ検証が取り直される (#703)。
 */

const FOLDER = 'watched';
const PROOF_NAME = 'submission_proof.json';
/** 改ざんで打鍵の記録に差し込む印。結果パネルの本文 (イベントの再生) に出る。 */
const MARK = 'TAMPERED';

/** export ZIP の proof を (必要なら書き換えて) `PROOF_NAME` の名前で書き出す。上書きの前後で同じ名前にするため。 */
async function writeProofVariant(zipPath: string, mutate?: (proof: Record<string, unknown>) => void): Promise<string> {
  const proof = await readProofJson(zipPath);
  mutate?.(proof);
  const dest = join(mkdtempSync(join(tmpdir(), 'tc-e2e-folder-update-')), PROOF_NAME);
  await writeFile(dest, JSON.stringify(proof));
  return dest;
}

/**
 * 文字列を持つ最後の打鍵イベントと `content` の両方に `MARK` を足す (hash を再計算しないのでチェーンが切れ、
 * 検証は失敗する)。結果パネルの本文 (コードプレビュー) は、最終状態に proof の `content` を、それが無いときは
 * イベントの再生を出すので、両方に印を入れて、どちらの proof を表示しているかを本文で見分けられるようにする。
 * 最後のイベントに足すのは、後続の打鍵の位置で印が崩れないため。
 */
function tamperContent(proof: Record<string, unknown>): void {
  const events = (proof.proof as { events: Array<Record<string, unknown>> }).events;
  const target = [...events]
    .reverse()
    .find((e) => e.type === 'contentChange' && typeof e.data === 'string' && e.data.length > 0);
  if (!target) throw new Error('no content-change event with data to tamper');
  target.data = `${target.data as string}${MARK}`;
  proof.content = `${proof.content as string}${MARK}`;
}

/**
 * フォルダのファイルを `file` で上書きし、proof の行の `data-status` が `reached` を満たすまで待つ。
 * 監視の開始 (初期スナップショット) より前に書き込むと変更として拾われないので、拾われなければ書き直す。
 */
async function overwriteAndWait(
  web: VerifyWebApp,
  file: VerifyFolderFile,
  reached: (status: VerifyFileStatus | undefined) => boolean
): Promise<void> {
  await expect(async () => {
    await web.overwriteFolderFile(FOLDER, file);
    await expect
      .poll(async () => reached((await web.fileStates()).find((f) => f.filename === PROOF_NAME)?.status), {
        timeout: 10_000,
        intervals: [250, 500],
      })
      .toBe(true);
  }).toPass({ timeout: 60_000 });
}

/** 一時ディレクトリに `name` で `bytes` を書き、そのパスを返す。 */
async function writeTemp(name: string, bytes: string | Uint8Array): Promise<string> {
  const dest = join(mkdtempSync(join(tmpdir(), 'tc-e2e-folder-update-')), name);
  await writeFile(dest, bytes);
  return dest;
}

/** `screenshots/manifest.json`: `image` を 1 枚だけ指す (imageHash は `image` の SHA-256)。 */
function screenshotManifest(filename: string, image: Uint8Array): string {
  return JSON.stringify({
    version: '1.0',
    exportedAt: new Date().toISOString(),
    totalScreenshots: 1,
    screenshots: [
      {
        index: 0,
        filename,
        imageHash: createHash('sha256').update(image).digest('hex'),
        captureType: 'periodic',
        eventSequence: 1,
        timestamp: 0,
        createdAt: Date.now(),
        displayInfo: {},
        fileSizeBytes: image.length,
      },
    ],
  });
}

test('#695: 監視中のフォルダで改ざんした proof を正常な proof で上書きすると、開いているタブの判定と本文が新しい proof になる', async ({
  page,
}) => {
  const zipPath = await typeAndExport(new EditorApp(page));
  const clean = await writeProofVariant(zipPath);
  const tampered = await writeProofVariant(zipPath, tamperContent);
  const web = new VerifyWebApp(page);

  await web.open('fast');
  await web.openFolder(FOLDER, [tampered]);
  await web.waitSettled(1);
  const before = await web.readVerdict(PROOF_NAME);
  expectWebCliParity([before], runVerifyCliWithVerdicts(tampered, ['--mode', 'fast']));
  expect(before.status).toBe('error');
  expect(await web.previewContent()).toContain(MARK);

  await overwriteAndWait(web, clean, (s) => s === 'success' || s === 'warning');

  const after = await web.readVerdict(PROOF_NAME);
  expectWebCliParity([after], runVerifyCliWithVerdicts(clean, ['--mode', 'fast']));
  expect(after.integrity).toBe('partial'); // fast は PoSW を再計算しない (#214)
  expect(after.level).not.toBe('failed');
  expect(await web.displayedFilename()).toBe(PROOF_NAME);
  expect(await web.previewContent()).not.toContain(MARK);
});

test('#695: 監視中のフォルダで正常な proof を改ざんした proof で上書きすると、新しい本文と失敗の判定が出て古い本文が残らない', async ({
  page,
}) => {
  const zipPath = await typeAndExport(new EditorApp(page));
  const clean = await writeProofVariant(zipPath);
  const tampered = await writeProofVariant(zipPath, tamperContent);
  const web = new VerifyWebApp(page);

  await web.open('fast');
  await web.openFolder(FOLDER, [clean]);
  await web.waitSettled(1);
  const before = await web.readVerdict(PROOF_NAME);
  expect(before.status).not.toBe('error');
  expect(await web.previewContent()).not.toContain(MARK);

  await overwriteAndWait(web, tampered, (s) => s === 'error');

  const after = await web.readVerdict(PROOF_NAME);
  expectWebCliParity([after], runVerifyCliWithVerdicts(tampered, ['--mode', 'fast']));
  expect(after.level).toBe('failed');
  expect(await web.displayedFilename()).toBe(PROOF_NAME);
  expect(await web.previewContent()).toContain(MARK);
});

test('#703: 監視中のフォルダで screenshots/ の画像を別の画像に置き換えると、proof のスクショ検証が取り直されて改竄が出る', async ({
  page,
}) => {
  const zipPath = await typeAndExport(new EditorApp(page));
  const proof = await writeProofVariant(zipPath);
  // casual の export はスクショを撮らない (チェーンに screenshotCapture が無い) ので、画像は manifest のハッシュとだけ突き合わされる
  const shot = 'shot-0.png';
  const original = new TextEncoder().encode('original screenshot');
  const replaced = new TextEncoder().encode('replaced screenshot');
  const web = new VerifyWebApp(page);

  await web.open('fast');
  await web.openFolder(FOLDER, [
    proof,
    { path: 'screenshots/manifest.json', from: await writeTemp('manifest.json', screenshotManifest(shot, original)) },
    { path: `screenshots/${shot}`, from: await writeTemp(shot, original) },
  ]);
  await web.waitSettled(1);
  const before = await web.readVerdict(PROOF_NAME);
  expect(before.status).not.toBe('error');
  expect(await web.trustIssues()).not.toContainEqual({ component: 'screenshots', severity: 'error' });

  await overwriteAndWait(
    web,
    { path: `screenshots/${shot}`, from: await writeTemp(shot, replaced) },
    (s) => s === 'error'
  );

  const after = await web.readVerdict(PROOF_NAME);
  expect(after.level).toBe('failed');
  expect(await web.trustIssues()).toContainEqual({ component: 'screenshots', severity: 'error' });
  // proof 本文は書き換えていないので、表示する本文は元の proof のまま (#695 の 1 スナップショット)
  expect(await web.displayedFilename()).toBe(PROOF_NAME);
  expect(await web.previewContent()).not.toContain(MARK);
});
