import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { EditorApp } from './app.js';
import { loadExamFixture } from './examFixture.js';
import {
  classPackageFile,
  loadClassPackage,
  openSelfReviewForCurrentTab,
  waitDialogClosed,
  waitDialogOpen,
} from './scenario.js';
import { VerifyWebApp } from './verifyWeb.js';

/**
 * a11y (axe)・i18n の漏れ・レイアウトの退行検査 (#728) が共通に回る「画面の巡回」。
 *
 * 対象の画面をここで固定する: 各モード (casual / class / assignment / exam) の ready、About、
 * 共通のダイアログ (セルフレビュー・画面共有の選択・ウェルカム・問題の読み込み・試験ゲート)、
 * 検証 Web の初期 / 結果表示。巡回は 5 本の流れ (`TourFlow`) に分け、各画面に着いたら `visit(screen)` を呼ぶ。
 * 検査の中身 (axe / キー名の漏れ / はみ出し) は呼び出し側の spec が決める。
 *
 * どの画面も export を伴わない (export 前の Turnstile 認証に入らない) ので、外部に届かない手元でも開ける。
 * 検証 Web の結果表示は verify-cli の有効な fixture の proof (`valid.json`) を入れて開く。
 */

export type ScreenId =
  | 'casual-ready'
  | 'casual-about'
  | 'casual-self-review'
  | 'class-screen-share-choice'
  | 'class-welcome'
  | 'class-problem-loader'
  | 'class-ready'
  | 'assignment-welcome'
  | 'assignment-ready'
  | 'exam-gate'
  | 'exam-ready'
  | 'verify-initial'
  | 'verify-result';

export type TourFlow = 'casual' | 'class' | 'assignment' | 'exam' | 'verify';

export const TOUR_FLOWS: readonly TourFlow[] = ['casual', 'class', 'assignment', 'exam', 'verify'];

/** 流れごとに訪れる画面 (表示順)。spec のタイトルと、基準の画面名の値域に使う。 */
export const FLOW_SCREENS: Readonly<Record<TourFlow, readonly ScreenId[]>> = {
  casual: ['casual-ready', 'casual-about', 'casual-self-review'],
  class: ['class-screen-share-choice', 'class-welcome', 'class-problem-loader', 'class-ready'],
  assignment: ['assignment-welcome', 'assignment-ready'],
  exam: ['exam-gate', 'exam-ready'],
  verify: ['verify-initial', 'verify-result'],
};

export type ScreenVisitor = (screen: ScreenId) => Promise<void>;

/** 検証 Web の結果表示に入れる proof (verify-cli の有効な fixture。export に依存しない)。 */
const VALID_PROOF = fileURLToPath(
  new URL('../../../verify-cli/src/__tests__/fixtures/proofs/valid.json', import.meta.url)
);

/**
 * 同じ origin (dev サーバの localhost) 以外への通信を全部止める。
 *
 * 手元 (外部に届かない) と CI (Turnstile・Wasmer の配信元に届く) で画面を揃えるため。届くと
 * Turnstile の widget (cross-origin の iframe。製品の DOM ではない) やランタイムの状態表示が変わり、
 * axe の結果・表示テキストが環境で食い違う。止めたときの表示 (認証は失敗のフォールバック、C の
 * ランタイムは初期化失敗) は製品の正規の経路で、検査の対象として扱う。
 */
export async function blockExternalRequests(page: Page): Promise<void> {
  await page.context().route(
    (url) => url.hostname !== 'localhost' && url.hostname !== '127.0.0.1',
    (route) => route.abort('blockedbyclient')
  );
}

/**
 * 画面が落ち着くまで待つ: 有限回の CSS アニメーション・トランジションが終わり、2 フレーム描画する。
 * 開いた直後のダイアログのフェードイン中に色のコントラストや位置を測ると、測るたびに結果が変わる。
 * 無限に回るもの (スピナー・点滅) は待たない。
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity),
    undefined,
    { timeout: 10_000 }
  );
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  );
}

/** 流れ `flow` を新しいページで最初から巡り、各画面で `visit` を呼ぶ。 */
export async function walkTour(page: Page, flow: TourFlow, visit: ScreenVisitor): Promise<void> {
  await blockExternalRequests(page);
  const at = async (screen: ScreenId) => {
    await settle(page);
    await test.step(`screen: ${screen}`, () => visit(screen));
  };
  const app = new EditorApp(page);

  switch (flow) {
    case 'casual': {
      await app.openCasualFresh();
      await at('casual-ready');

      await page.locator('#settings-btn').click();
      await page.locator('#about-btn').click();
      await page.locator('.modal-about[role="dialog"]').waitFor({ state: 'visible' });
      await at('casual-about');
      await page.keyboard.press('Escape');
      await expect(page.locator('.modal-about')).toHaveCount(0);

      await app.typeCode('int a;');
      await openSelfReviewForCurrentTab(app);
      await at('casual-self-review');
      await page.locator('[data-dialog="self-review"] .self-review-btn-cancel').click();
      await waitDialogClosed(app, 'self-review');
      return;
    }
    case 'class': {
      await app.openModeFresh('class', { waitReady: false });
      await waitDialogOpen(app, 'screen-share-choice');
      await at('class-screen-share-choice');
      await page.locator('.screen-share-choice-dialog [data-choice="share"]').click();

      await waitDialogOpen(app, 'welcome');
      await at('class-welcome');

      // loadClassPackage と同じ手順を、ローダーが開いた所で一度止めて巡る。
      await page.locator('#load-problem-btn').click();
      await waitDialogOpen(app, 'class-problem-loader');
      await at('class-problem-loader');
      await page.locator('#class-loader-file').setInputFiles(classPackageFile());
      const load = page.locator('#class-loader-load');
      await expect(load).toBeEnabled();
      await load.click();
      await waitDialogClosed(app, 'class-problem-loader');
      await app.waitReady();
      await expect(page.locator('#problem-panel')).toHaveAttribute('data-open', 'true', { timeout: 30_000 });
      await at('class-ready');
      return;
    }
    case 'assignment': {
      await app.openModeFresh('assignment', { waitReady: false });
      await waitDialogOpen(app, 'welcome');
      await at('assignment-welcome');
      await loadClassPackage(app);
      await at('assignment-ready');
      return;
    }
    case 'exam': {
      const fixture = loadExamFixture();
      // CI で fixture が無いのは setup の配線の壊れ。skip で緑にせず落とす (exam-roundtrip.spec.ts と同じ扱い)。
      if (!fixture) {
        if (process.env.CI)
          throw new Error('exam fixture is missing: `npm run setup -w @typedcode/e2e` did not generate it');
        test.skip(true, 'exam fixture 未生成 (npm run setup -w @typedcode/e2e で作る)');
        return;
      }
      await app.openModeFresh('exam', { screenShare: 'share', waitReady: false });
      await expect.poll(() => app.appState()).toBe('gate');
      await at('exam-gate');
      await app.unlockExam(fixture.packagePath, fixture.code);
      await at('exam-ready');
      return;
    }
    case 'verify': {
      const web = new VerifyWebApp(page);
      await web.open('fast');
      await at('verify-initial');
      await web.load([VALID_PROOF]);
      await web.readVerdict(basename(VALID_PROOF));
      await at('verify-result');
      return;
    }
  }
}
