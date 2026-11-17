import { deflateSync } from 'node:zlib';
import { test, expect, type Page } from '@playwright/test';
import { VerifyWebApp } from './helpers/verifyWeb.js';

/**
 * verify Web の画像プレビューが Blob URL を例外なく解放する (#729)。
 *
 * 旧実装は `<img onload="URL.revokeObjectURL(this.src)">` を innerHTML に埋め込んでいた。inline の
 * イベントハンドラの中では `URL` が `document.URL` (文字列) に解決されるので、読み込みのたびに
 * `TypeError: URL.revokeObjectURL is not a function` が pageerror になり、URL は解放されなかった。
 *
 * 画像は editor の export を要さないので、手で作った PNG を OPFS のフォルダの `screenshots/` に置き、
 * 「フォルダを開く」から入れる (`showDirectoryPicker` だけを OPFS のハンドルに差し替える。走査と監視は本物)。
 * 外部更新 (#696) は OPFS のファイルの上書きで起こし、3 秒間隔のフォルダ監視に拾わせる。
 * 表示されたかは `naturalWidth` (PNG ごとに幅を変えてある) で、解放されたかは `URL.revokeObjectURL` の
 * 呼び出しの記録で見る。
 */

const FOLDER = 'pictures';
const PREVIEW = '#plaintext-code img.image-preview';

/** 幅 `width`・高さ `height` の真っ白な 8bit グレースケール PNG。 */
function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  // 各行の先頭はフィルタ種別 0 (None)
  const raw = Buffer.alloc((width + 1) * height, 0xff);
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** OPFS の `FOLDER/screenshots/<name>` に PNG を書く (既存なら全置換)。 */
async function writeScreenshot(page: Page, name: string, bytes: Buffer): Promise<void> {
  await page.evaluate(
    async ({ folder, name, base64 }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await (await root.getDirectoryHandle(folder, { create: true })).getDirectoryHandle('screenshots', {
        create: true,
      });
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
      await writable.close();
    },
    { folder: FOLDER, name, base64: bytes.toString('base64') }
  );
}

/** `FOLDER` を「フォルダを開く」から開く (選択ダイアログだけを OPFS のハンドルに差し替える)。 */
async function openPictureFolder(page: Page): Promise<void> {
  await page.evaluate(async (folder) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(folder);
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker =
      async () => dir;
  }, FOLDER);
  await page.locator('#main-menu-btn').click();
  await page.locator('#open-folder-btn').click();
  // サブフォルダは畳まれて並ぶので、screenshots/ を開いて画像の行を出す
  await page
    .locator('#file-list .folder-item')
    .filter({ has: page.locator('.folder-name', { hasText: /^screenshots$/ }) })
    .click();
}

/** 表示中のプレビューが読み込みを終え、幅が `width` になるのを待ち、その `src` を返す。 */
async function waitPreviewWidth(page: Page, width: number, timeout = 10_000): Promise<string> {
  const img = page.locator(PREVIEW);
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : -1)), { timeout })
    .toBe(width);
  return (await img.getAttribute('src'))!;
}

test('#729: 画像プレビューの初期表示・外部更新・別画像への切替で pageerror が出ず、表示した Blob URL がすべて解放される', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  // 解放された URL を記録する (本物の revokeObjectURL はそのまま呼ぶ)
  await page.addInitScript(() => {
    const revoked: string[] = [];
    (window as unknown as { __revokedBlobUrls: string[] }).__revokedBlobUrls = revoked;
    const original = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
      original(url);
    };
  });
  const revokedUrls = (): Promise<string[]> =>
    page.evaluate(() => [...(window as unknown as { __revokedBlobUrls: string[] }).__revokedBlobUrls]);

  const web = new VerifyWebApp(page);
  await web.open('fast');
  await writeScreenshot(page, 'a.png', png(4, 3));
  await writeScreenshot(page, 'b.png', png(7, 5));
  await openPictureFolder(page);

  // 初期表示
  await web.selectFile('a.png');
  const initial = await waitPreviewWidth(page, 4);

  // 外部更新 (#696): 監視の開始より前に書いた上書きは拾われないので、拾われるまで書き直す
  let updated = '';
  await expect(async () => {
    await writeScreenshot(page, 'a.png', png(9, 2));
    updated = await waitPreviewWidth(page, 9);
  }).toPass({ timeout: 60_000 });
  expect(updated).not.toBe(initial);

  // 別画像への切替
  await web.selectFile('b.png');
  const other = await waitPreviewWidth(page, 7);

  expect(pageErrors).toEqual([]);
  await expect.poll(revokedUrls).toEqual(expect.arrayContaining([initial, updated, other]));
  const revoked = await revokedUrls();
  for (const url of [initial, updated, other]) {
    expect(
      revoked.filter((u) => u === url),
      `${url} is revoked exactly once`
    ).toHaveLength(1);
  }
});
