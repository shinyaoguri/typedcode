import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import {
  EditorApp,
  appendToStoredTabContent,
  listProofEntries,
  tamperFirstContentChange,
  writeZipVariant,
} from './helpers/app.js';
import { VerifyWebApp } from './helpers/verifyWeb.js';
import { failStorageProbe } from './helpers/faults.js';
import { waitDialogOpen } from './helpers/scenario.js';

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
 * - 言語は locale で決める (context が新しく localStorage が空なので、言語設定は navigator.language →
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
  {
    file: '05-main-menu.png',
    caption: 'エディタ (通常モード): メインメニューを開いた状態 (時計とハッシュは隠している)',
  },
  {
    file: '06-verify-verifying.png',
    caption: '検証 Web (full モード): 検証中の proof の進捗表示とキャンセルボタン (経過時間は隠している)',
  },
  {
    file: '07-verify-cancelled.png',
    caption: '検証 Web: 検証をキャンセルした proof (未検証の表示と再検証ボタン、ステータスバーのキャンセル件数)',
  },
  {
    file: '08-verify-cancel.webp',
    caption: '検証 Web: 検証中の proof をキャンセルする操作 (キャンセル後に次の proof の検証が進む)',
  },
  {
    file: '09-unproven-content.png',
    caption:
      'エディタ: 処理待ちを残して閉じた後に再開したときの通知 (証明に載らなかった編集。元のコードと証明の文字数、差分とダウンロード)',
  },
  {
    file: '10-unproven-content-diff.png',
    caption: 'エディタ: 同じ通知で差分を開いた状態 (左が証明の版、右が元のコード。読み取り専用)',
  },
  {
    file: '11-verify-analysis-unavailable.png',
    caption:
      '検証 Web: 分析カードで、どの分析器も結果を返せなかった (失敗・時間切れ) ときの表示 (分析器を失敗させたレポートを差し込んで描画)',
  },
  {
    file: '12-verify-analysis-partial.png',
    caption:
      '検証 Web: 分析カードで、一部の分析器だけが結果を返せなかったときの表示 (分析器を失敗させたレポートを差し込んで描画)',
  },
  {
    file: '13-verify-anchoring.png',
    caption:
      '検証 Web: 時刻アンカーカードを開き、詳細を広げた状態 (post-hoc の判定に使う時刻の要約行と、時間スパン分析の欄)',
  },
  {
    file: '14-storage-low.png',
    caption:
      'エディタ: 起動時の空き容量の試験で書き込めなかったときの警告 (このまま続ける / もう一度確かめる。書き込みを容量切れにして表示)',
  },
  {
    file: '15-landing.png',
    caption: 'エディタ: ランディング (モード選択の比較カードと、その下の全モード共通の注記)',
  },
  {
    file: '16-terms-bot-detection.png',
    caption: 'エディタ (授業モード): 利用規約の「Bot検出」を開いた状態 (Turnstile の説明)',
  },
] as const;

type ShotFile = (typeof SHOTS)[number]['file'];

/**
 * 打つコード。verify-web-*.spec.ts 等と同じもの (括弧の自動補完で崩れないことが確かめてある)。
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

    // 05: メインメニュー (#main-menu-btn) を開いた状態。項目の増減 (#442) が見た目で分かるように撮る。
    // 番号は manifest の並びを保つため末尾の 05 のまま、撮る順は 02 の直後 (まだエディタ画面にいるうち)。
    await page.locator('#main-menu-btn').click();
    await page.locator('#main-menu-dropdown').waitFor({ state: 'visible' });
    await page.screenshot({
      path: out('05-main-menu.png'),
      animations: 'disabled',
      mask: [page.locator('#titlebar-clock'), page.locator('#current-hash')],
    });
    await page.locator('#main-menu-btn').click();

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

  // 09〜10 (#413): PoSW の処理待ちを残して閉じた状態 (tabs の content にだけ打鍵が残る) から再開したときの通知。
  // 処理待ちの状態は、閉じた後に `/` の別ページから tabs の content の末尾を書き足して作る (close-tab-recovery.spec.ts と同じ)。
  test('復元時に証明と食い違った元のコードの通知と差分を撮る @shots', async ({ page, context }) => {
    const app = new EditorApp(page);
    await app.openCasualFresh();
    await app.typeCode(CODE);
    await app.waitForSynced();
    await page.close();

    const landing = await context.newPage();
    await landing.goto('/');
    await appendToStoredTabContent(landing, '// typed but not in the proof yet');
    await landing.close();

    const resumed = await context.newPage();
    await resumed.goto('/casual');
    const resume = resumed.locator('#session-resume-btn');
    await resume.waitFor({ state: 'visible', timeout: 15_000 });
    await resume.click();
    await new EditorApp(resumed).waitReady();
    const mask = [resumed.locator('#titlebar-clock'), resumed.locator('#current-hash')];

    // 09: 通知 (差分を開く前)。
    const dialog = resumed.locator('[data-dialog="unproven-content"]');
    await dialog.locator('.unproven-item').waitFor({ state: 'visible', timeout: 30_000 });
    await resumed.screenshot({ path: out('09-unproven-content.png'), animations: 'disabled', mask });

    // 10: 差分を開いた状態。Monaco の diff editor が行を描くまで待つ。
    await dialog.locator('[data-action="show-diff"]').click();
    await expect(dialog.locator('.unproven-diff')).toHaveAttribute('data-diff-tab-id', /.+/);
    await dialog.locator('.unproven-diff .editor.modified .view-line').first().waitFor({ state: 'visible' });
    await resumed.screenshot({ path: out('10-unproven-content-diff.png'), animations: 'disabled', mask });
  });

  // 14 (#626): 起動時の空き容量の試験で書けなかったときの警告。試験用 DB への書き込みだけを容量切れにする
  test('起動時の空き容量不足の警告を撮る @shots', async ({ page }) => {
    await failStorageProbe(page);
    const app = new EditorApp(page);
    await page.goto('/casual');
    await expect.poll(() => app.openDialogs()).toEqual(['storage-low']);
    await page.screenshot({
      path: out('14-storage-low.png'),
      animations: 'disabled',
      mask: [page.locator('#titlebar-clock')],
    });
  });

  // 15 (#240): ランディング。比較カードの下に全モード共通の注記がある
  test('ランディングを撮る @shots', async ({ page }) => {
    const app = new EditorApp(page);
    await page.goto('/');
    await expect.poll(() => app.appState()).toBe('landing');
    await page.screenshot({ path: out('15-landing.png'), animations: 'disabled' });
  });

  // 16 (#240): 利用規約の Bot 検出の説明。規約は casual 以外で未同意なら出るので class で開く
  test('利用規約の Bot 検出の説明を撮る @shots', async ({ page }) => {
    const app = new EditorApp(page);
    await app.openModeFresh('class', { acceptTerms: false, waitReady: false });
    await waitDialogOpen(app, 'terms');
    const bot = page.locator('[data-dialog="terms"] details:has([data-i18n="terms.botDetectionTitle"])');
    await bot.locator('summary').click();
    await bot.locator('[data-i18n-html="terms.botDetectionDesc"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: out('16-terms-bot-detection.png'), animations: 'disabled' });
  });

  // 11〜12 (#301): 分析器の失敗・時間切れを「シグナルなし」と区別する分析カード。同梱の分析器は通常の proof では
  // 失敗しないので、検証結果の画面を出した後、dev サーバが配る実物の AnalysisReportCard (`/src/...` はアプリと同じ
  // モジュール) に、分析器が失敗したレポートを渡して描き直す。proof は verify-cli の有効な fixture を使う。
  test('検証 Web の分析カードで分析できなかった分析器の表示を撮る @shots', async ({ page }) => {
    const fixtureProof = fileURLToPath(
      new URL('../../verify-cli/src/__tests__/fixtures/proofs/valid.json', import.meta.url)
    );
    const web = new VerifyWebApp(page);
    await web.open('fast');
    await web.load([fixtureProof]);
    await web.readVerdict(basename(fixtureProof));
    const card = page.locator('#card-analysis');
    await card.waitFor({ state: 'visible' });
    // カードは畳まれて出るので、見出しを押して中身を開く。
    await card.locator('.result-card-header').click();
    await expect(card).toHaveClass(/expanded/);

    const renderReport = async (report: unknown) => {
      await page.evaluate(
        async ({ modulePath, r }) => {
          const mod = await import(modulePath);
          new mod.AnalysisReportCard().render(r);
        },
        { modulePath: '/src/ui/AnalysisReportCard.ts', r: report }
      );
    };

    // 11: どの分析器も結果を返せなかった (signal 0 件でも「シグナルなし」ではない)。
    await renderReport({
      analyzerVersions: { automation: '0.1.0', 'focus-burst': '0.1.0' },
      analyzerStatus: {
        automation: { version: '0.1.0', status: 'failed', message: 'analyzer failure' },
        'focus-burst': { version: '0.1.0', status: 'timeout', message: 'did not settle within 10000 ms' },
      },
      signals: [],
      reviewPriority: 0,
    });
    await card.screenshot({ path: out('11-verify-analysis-unavailable.png'), animations: 'disabled' });

    // 12: 一部の分析器だけが結果を返せなかった (返せた分析器の signal は残る)。
    await renderReport({
      analyzerVersions: { automation: '0.1.0', 'focus-burst': '0.1.0' },
      analyzerStatus: {
        automation: { version: '0.1.0', status: 'ok' },
        'focus-burst': { version: '0.1.0', status: 'timeout', message: 'did not settle within 10000 ms' },
      },
      signals: [
        {
          analyzerId: 'automation',
          dimension: 'automation',
          score: 0.6,
          confidence: 0.8,
          severity: 'notice',
          evidence: [{ fromEventIndex: 3 }],
          summary: 'Synthetic keystrokes detected',
        },
      ],
      reviewPriority: 0.24,
    });
    await card.screenshot({ path: out('12-verify-analysis-partial.png'), animations: 'disabled' });
  });

  // 13 (#320): 時刻アンカーカード。署名チェックポイント付きの proof が要るので、エディタで打って export した ZIP を
  // 検証 Web (fast) に入れる。カードは畳まれて出るので見出しを押して開き、詳細 (<details>) も広げてから撮る。
  test('検証 Web の時刻アンカーカードを撮る @shots', async ({ page }) => {
    const app = new EditorApp(page);
    await app.openCasualFresh();
    await app.typeCode(CODE);
    const zipPath = await app.exportCurrentTab();
    const [proof] = (await listProofEntries(zipPath)).map((n) => basename(n));
    if (!proof) {
      console.warn('[shots] ZIP に proof が無いので 13 を飛ばす');
      return;
    }
    const web = new VerifyWebApp(page);
    await web.open('fast');
    await web.load([zipPath]);
    await web.readVerdict(proof);
    const card = page.locator('#card-anchoring');
    await card.waitFor({ state: 'visible' });
    await card.locator('.result-card-header').click();
    await expect(card).toHaveClass(/expanded/);
    const details = page.locator('#anchoring-details');
    if (await details.isVisible()) {
      await details.evaluate((el) => {
        (el as HTMLDetailsElement).open = true;
      });
    }
    // 詳細を広げたカードは 800px に収まらず、下端がステータスバーで切れる。この 1 枚だけ縦に広げて撮る。
    await page.setViewportSize({ width: 1280, height: 1800 });
    await card.screenshot({ path: out('13-verify-anchoring.png'), animations: 'disabled' });
  });

  // 06〜08 (#331): 検証中の進捗表示 (キャンセルボタン) と、キャンセルした後の表示。キャンセルは処理中の項目への
  // 操作なので full で流す (fast は一瞬で終わり、処理中を撮れない)。打鍵は verify-web-ui.spec.ts のキャンセルの
  // spec と同じく、コメント 1 行を足して検証の時間を稼ぐ。
  test('検証 Web の検証中とキャンセル後の画面を撮る @shots', async ({ page }) => {
    const app = new EditorApp(page);
    await app.openCasualFresh();
    await app.typeCode(`// padding line for a slower full verification\n${CODE}`);
    const zipPath = await app.exportCurrentTab();
    const first = await writeZipVariant(zipPath, { renameProof: 'first', outName: 'first.zip' });
    const second = await writeZipVariant(zipPath, { renameProof: 'second', outName: 'second.zip' });
    const web = new VerifyWebApp(page);
    await web.open('full');
    await web.addFiles([first, second]);

    const verifying = page.locator('#file-list .file-item[data-status="verifying"]');
    await verifying.first().waitFor({ state: 'attached', timeout: 60_000 });
    const target = await verifying.first().getAttribute('data-filename');
    if (!target) {
      console.warn('[shots] 検証中の行を掴めなかったので 06〜08 を飛ばす');
      return;
    }
    await web.selectFile(target);
    const elapsed = page.locator('#vp-overall-time');

    // 06: 検証中 (キャンセルボタンが見える)。
    await page.screenshot({ path: out('06-verify-verifying.png'), animations: 'disabled', mask: [elapsed] });

    // 08: キャンセルの前後をコマ撮りする。
    mkdirSync(FRAMES, { recursive: true });
    const frames: string[] = [];
    const snap = async () => {
      const path = join(FRAMES, `frame.${String(frames.length + 1).padStart(4, '0')}.png`);
      await page.screenshot({ path, animations: 'disabled', mask: [elapsed] });
      frames.push(path);
    };
    for (let i = 0; i < 4; i++) await snap();
    await web.cancelVerification();
    for (let i = 0; i < 6; i++) await snap();

    // 07: もう 1 件の検証が済み、ステータスバーに集約 (キャンセル件数を含む) が出てから撮る。
    await web.waitSettled(2, 240_000);
    await expect.poll(() => web.proofSummary()).not.toBeNull();
    await snap();
    const last = frames.at(-1);
    if (last) for (let i = 0; i < 10; i++) frames.push(last);
    bundleWebp(frames, out('08-verify-cancel.webp'));
    rmSync(FRAMES, { recursive: true, force: true });
    await page.screenshot({ path: out('07-verify-cancelled.png'), animations: 'disabled' });
  });
});
