import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { EditorApp, listProofEntries, tamperFirstContentChange, writeZipVariant } from './helpers/app.js';
import { VerifyWebApp } from './helpers/verifyWeb.js';

/**
 * 見た目・動きの証跡 (`@shots`, #391 / ADR-0036)。**何も assert しない**。人が見るための画像を吐くだけ。
 *
 * E2E は見た目を画素で比べない (ADR-0034) ので、見た目の正しさの担い手は人の目になる。UI を変えた
 * PR の本文に before/after を載せるための素材を、手元 (`npm run shots -w @typedcode/e2e`) と CI
 * (#393: base と head の両方で同じ spec を撮って並べる) で同じように撮れるようにする。
 *
 * - 通常の E2E (`npm run test -w @typedcode/e2e` / CI のシャード) からは playwright.config.ts の
 *   `grepInvert` で外してある。タイトルの `@shots` が目印
 * - 待ち合わせは data-* の状態契約と既存ヘルパの wait 系だけで行い、翻訳テキストは読まない
 *   (packages/e2e/AGENTS.md)。検証は fast (不変条件 4)
 * - 言語は locale で決める (`?reset` が localStorage を消すので、言語設定は navigator.language →
 *   既定の順に落ちる)。時刻・配色・画面幅も固定し、base と head で同じ条件の画像を得る
 * - 撮影後の画像はリポジトリにコミットしない (shots/ は gitignore 済み)。Gyazo へ上げて URL を貼る
 */

/** 置き場。gitignore 済み。 */
const OUT = fileURLToPath(new URL('../shots/', import.meta.url));
/** コマ撮りの一時置き場 (束ねた後に消す)。 */
const FRAMES = join(OUT, 'frames');

/** 1 コマの表示時間 (ms)。15fps 相当。 */
const FRAME_MS = 67;
/** Gyazo とプレビューで扱いやすい上限。超えたら近似可逆で作り直す。 */
const MAX_WEBP_BYTES = 4 * 1024 * 1024;

/**
 * 撮る画面と、その説明。**並び順・ファイル名・文言はここが正本**。
 *
 * CI (#393) は base と head でこの manifest を読み、同じ `file` 同士を並べる。ファイル名を変えると
 * before/after が対にならなくなるので、変えるときは連番ごと付け直す。実際に撮れたかどうかは
 * CI 側がファイルの有無で見る (撮れなかった画面があっても manifest は残す)。
 */
const SHOTS = [
  { file: '01-editor-typing.webp', caption: 'エディタ (通常モード): コードを打鍵していく様子' },
  { file: '02-editor.png', caption: 'エディタ (通常モード): 打ち終えた状態 (時計とハッシュは隠している)' },
  {
    file: '03-verify-result.png',
    caption: '検証 Web: export した ZIP の検証結果 (fast モードなので整合性は partial 表示)',
  },
  {
    file: '04-verify-summary.png',
    caption:
      '検証 Web: 正常な proof と改ざんした proof の ZIP を同時に読んだときのステータスバーの集約 (N/M と失敗件数)',
  },
] as const;

type ShotFile = (typeof SHOTS)[number]['file'];

/**
 * 打つコード。verify-web.spec.ts 等と同じもの (括弧の自動補完で崩れないことが確かめてある)。
 * コマ撮りのため 1〜2 文字ずつ打つ。
 */
const CODE = 'int main(void) {\n  return 0;\n}\n';
const CHARS_PER_FRAME = 2;

function out(file: ShotFile): string {
  return join(OUT, file);
}

/**
 * 撮る範囲: エディタ (タブ列を含む) からステータスバーまで。全画面だと WebP が大きくなるので
 * 動きのある所に絞る。
 */
async function typingClip(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
  const tabs = await page.locator('#editor-tabs').boundingBox();
  const status = await page.locator('.statusbar').boundingBox();
  const top = Math.max(0, Math.floor(tabs?.y ?? 0));
  const bottom = Math.min(viewport.height, Math.ceil(status ? status.y + status.height : viewport.height));
  return { x: 0, y: top, width: viewport.width, height: bottom - top };
}

/**
 * コマを可逆のアニメーション WebP に束ねる (GIF は 256 色に落ちるので使わない)。大きすぎれば
 * 近似可逆 (`-near_lossless`) で作り直す。img2webp が無ければ警告して飛ばす (manifest は残す)。
 */
function bundleWebp(frames: string[], dest: string): void {
  const run = (extra: string[]) =>
    spawnSync('img2webp', ['-loop', '0', '-d', String(FRAME_MS), ...extra, ...frames, '-o', dest], {
      encoding: 'utf8',
    });
  let result = run([]);
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    console.warn(
      '[shots] img2webp が見つからないので WebP を飛ばす (macOS: brew install webp / Debian: apt-get install webp)'
    );
    return;
  }
  if (result.status === 0 && statSync(dest).size > MAX_WEBP_BYTES) {
    result = run(['-near_lossless', '60']);
  }
  if (result.status !== 0) {
    console.warn(`[shots] img2webp が失敗したので WebP を飛ばす: ${result.stderr || result.error}`);
    rmSync(dest, { force: true });
  }
}

test.describe('見た目・動きの証跡 @shots', () => {
  test.use({
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    colorScheme: 'light',
    viewport: { width: 1280, height: 800 },
  });

  test.beforeAll(() => {
    // 前回の残骸 (今は撮らない画面の画像) が CI 側で拾われないよう作り直す。
    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(OUT, { recursive: true });
    // 撮る前に書く。撮れなかった画面があっても対応表は残す。
    writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(SHOTS, null, 2)}\n`);
  });

  test('エディタの打鍵から検証 Web の結果までを撮る @shots', async ({ page }) => {
    const app = new EditorApp(page);
    await app.openCasualFresh();
    await app.focusEditor();

    // 01: 打鍵の様子をコマ撮りしてアニメーション WebP に束ねる。
    mkdirSync(FRAMES, { recursive: true });
    const clip = await typingClip(page);
    const frames: string[] = [];
    const snap = async () => {
      const path = join(FRAMES, `frame.${String(frames.length + 1).padStart(4, '0')}.png`);
      await page.screenshot({ path, clip, animations: 'disabled', caret: 'initial' });
      frames.push(path);
    };
    await snap();
    for (let i = 0; i < CODE.length; i += CHARS_PER_FRAME) {
      await page.keyboard.type(CODE.slice(i, i + CHARS_PER_FRAME), { delay: 12 });
      await snap();
    }
    // 打ち終えた画面で少し止める (ループの切れ目で最後の状態が読めるように)。
    const last = frames.at(-1);
    if (last) for (let i = 0; i < 10; i++) frames.push(last);
    bundleWebp(frames, out('01-editor-typing.webp'));
    rmSync(FRAMES, { recursive: true, force: true });

    // 02: 打ち終えたエディタ全体。記録が落ち着いてから撮る。撮るたびに変わる時計とハッシュは隠す
    // (before/after で同じ所が違って見えないように)。
    await app.waitForSynced();
    await page.screenshot({
      path: out('02-editor.png'),
      mask: [page.locator('#titlebar-clock'), page.locator('#current-hash')],
    });

    // 03: export した ZIP を検証 Web (fast) に入れ、proof の結果画面を撮る。
    const zipPath = await app.exportCurrentTab();
    const [proof] = (await listProofEntries(zipPath)).map((n) => basename(n));
    const web = new VerifyWebApp(page);
    await web.open('fast');
    await web.load([zipPath]);
    if (!proof) {
      console.warn('[shots] ZIP に proof が無いので検証 Web の画面を飛ばす');
      return;
    }
    // readVerdict は data-* 属性が現れるまで待つ (判定が描画し終わった合図)。値は見ない。
    await web.readVerdict(proof);
    await page.screenshot({ path: out('03-verify-result.png') });

    // 04: 正常と改ざんの 2 proof を同時に読み、検証完了後のステータスバーの集約 (#282) を撮る。
    const tamperedZip = await writeZipVariant(zipPath, {
      mutateProof: tamperFirstContentChange,
      renameProof: 'tampered',
      outName: 'tampered.zip',
    });
    const cleanZip = await writeZipVariant(zipPath, { renameProof: 'clean', outName: 'clean.zip' });
    await web.open('fast');
    await web.load([cleanZip, tamperedZip]);
    // 集約は検証完了の次のタスクで描かれる。data-proof-* が付くのを待つ (値は見ない)。
    await expect.poll(() => web.proofSummary()).not.toBeNull();
    await page.screenshot({ path: out('04-verify-summary.png') });
  });
});
