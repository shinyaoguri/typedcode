import { test, expect, type Page } from '@playwright/test';
import { EditorApp, readAllProofEvents, readProofJson } from '../helpers/app.js';
import { runVerifyCli } from '../helpers/verifyCli.js';
import {
  CLASS_POLICIES,
  SAMPLE_CLASS_ID,
  classPackageFile,
  loadClassPackage,
  sampleClassPackage,
  waitDialogOpen,
  waitResumed,
  workspacePath,
} from '../helpers/scenario.js';

/**
 * #646: 配布物ごとの作業スペース。`.tcclass` を読み込むと、その配布物の作業スペース
 * (`/w/class/<classId>/<方針>`) へ移って問題のタブが開く。練習 (`/`)・旧来の入口 (`/class` など)・別の配布物の
 * 作業スペースとはタブも保存領域も混ざらない。同じ classId・同じ方針の改訂はその場で問題文だけを差し替える。
 * `proof.mode` は配布物の方針から決まる (教室で実施 = class、持ち帰り = assignment、それ以外はスクリーンショットの有無)。
 *
 * 判定は URL・状態契約 (data-*・`__tcTestSnapshot`)・export した proof と verify-cli (fast) で行う。
 */

const TAKE_HOME_PATH = workspacePath(SAMPLE_CLASS_ID, CLASS_POLICIES.takeHome);

/** 練習 (`/`) を規約に同意済みで開く (移り先の作業スペースで規約のモーダルを出さないため) */
async function openPractice(app: EditorApp): Promise<void> {
  await app.openModeFresh('casual', { acceptTerms: true });
}

/** タブのファイル名と中身 (`__tcTestSnapshot` の表示順) */
async function tabContents(app: EditorApp): Promise<Array<{ id: string; filename: string; content: string }>> {
  return (await app.snapshot()).tabs.map((t) => ({ id: t.id, filename: t.filename, content: t.content }));
}

/** 同じ文書のままか (ページが移っていないか) を見るための印を付ける */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __tcSameDocument?: boolean }).__tcSameDocument = true;
  });
}

function isSameDocument(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __tcSameDocument?: boolean }).__tcSameDocument === true);
}

/**
 * 名前で選んだ IndexedDB の中身を、全ストアの全行の JSON にして返す (無い DB は null)。開くのは既にある DB だけ
 * (版を指定しない open は、無い DB を作ってしまうので先に一覧で確かめる)。
 */
function dumpDatabase(page: Page, name: string): Promise<string | null> {
  return page.evaluate(async (dbName) => {
    const names = (await indexedDB.databases()).map((d) => d.name);
    if (!names.includes(dbName)) return null;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const out: Record<string, unknown[]> = {};
    for (const store of [...db.objectStoreNames].sort()) {
      out[store] = await new Promise<unknown[]>((resolve, reject) => {
        const req = db.transaction(store, 'readonly').objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result as unknown[]);
        req.onerror = () => reject(req.error);
      });
    }
    db.close();
    return JSON.stringify(out);
  }, name);
}

/** 旧来の名前空間の localStorage / sessionStorage のキー (#646 の前から使っているもの) の値 */
function legacyKeys(page: Page): Promise<Record<string, string | null>> {
  return page.evaluate(() => {
    const out: Record<string, string | null> = {};
    for (const ns of ['', '-class', '-assignment', '-exam']) {
      for (const key of ['typedcode-class-problems', 'typedcode-class-policy', 'typedcode-exam-packages']) {
        out[`local:${key}${ns}`] = localStorage.getItem(`${key}${ns}`);
      }
      for (const key of ['typedcode-tabs', 'typedcode-session-active']) {
        out[`session:${key}${ns}`] = sessionStorage.getItem(`${key}${ns}`);
      }
    }
    return out;
  });
}

test('練習で書いている途中に .tcclass を読み込むと作業スペースへ移って問題のタブが開き、/ に戻ると練習のタブが残っている', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await openPractice(app);
  // 練習にも「問題を読み込む」が出る。問題パネルは読み込むまで出ない (練習の見た目は変えない)
  await expect(page.locator('#load-problem-btn')).toBeVisible();
  await expect(page.locator('#problem-panel')).toHaveAttribute('data-open', 'false');
  await app.typeCode('int practice;');
  await app.waitForSynced();
  const practice = await tabContents(app);
  expect(practice.map((t) => t.filename)).toEqual(['Untitled-1.c']);

  // 方針の無い .tcclass は、練習からは「持ち帰り」の作業スペースで開く (#646 の決定 4)
  await loadClassPackage(app);
  await expect(page).toHaveURL(new RegExp(`${TAKE_HOME_PATH}$`));
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'assignment');
  const problems = await tabContents(app);
  expect(problems.map((t) => t.filename)).toEqual(['p1.c', 'p2.c']);
  expect(problems.map((t) => t.content).join('')).not.toContain('int practice;');
  await app.expectConsistent();

  // 作業スペースで書いた proof の mode は方針から決まる (持ち帰り = assignment)
  await app.typeCode('int answer;');
  await app.waitForSynced();
  const zipPath = await app.exportViaLogButton();
  expect((await readProofJson(zipPath)).mode).toBe('assignment');
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);

  // 練習に戻ると、練習のタブが中身ごと残っている (作業スペースのタブは混ざらない)
  await app.waitForSynced();
  await page.goto('/');
  await waitResumed(app);
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'casual');
  expect(await tabContents(app)).toEqual(practice);
  await app.expectConsistent();
});

test('classId の違う 2 つの .tcclass を順に開くと、それぞれの作業スペースのタブが混ざらない', async ({ page }) => {
  const app = new EditorApp(page);
  await openPractice(app);
  await loadClassPackage(app);
  await expect(page).toHaveURL(new RegExp(`${TAKE_HOME_PATH}$`));
  await app.typeCode('int first_class;');
  await app.waitForSynced();
  const first = await tabContents(app);

  // 別の classId・プリセットに無い方針 (スクリーンショットだけ撮る) の配布物を、作業スペースの中から読む
  const custom = { screenshots: true, fullscreenTracking: false, preExportBestEffort: false };
  const second = {
    ...sampleClassPackage(),
    classId: 'algo-week4',
    policy: custom,
    bundle: { schema: 'tcexam-exam/1', problems: [{ problemId: 'q1', statement: '# 問題 q1' }] },
  };
  await loadClassPackage(app, classPackageFile(second));
  await expect(page).toHaveURL(/\/w\/class\/algo-week4\/custom-100$/);
  // プリセットに無い方針は、スクリーンショットを撮るなら class (#646 の決定 5)
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'class');
  const secondTabs = await tabContents(app);
  expect(secondTabs.map((t) => [t.filename, t.content])).toEqual([['q1.c', '']]);
  await app.typeCode('int second_class;');
  await app.waitForSynced();
  const zipPath = await app.exportViaLogButton();
  const proofs = [...(await readAllProofEvents(zipPath)).keys()];
  expect(proofs).toHaveLength(1);
  expect((await readProofJson(zipPath)).mode).toBe('class');
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);

  // 最初の作業スペースに戻ると、そのタブだけが中身ごと残っている
  await app.waitForSynced();
  await page.goto(TAKE_HOME_PATH);
  await waitResumed(app);
  expect(await tabContents(app)).toEqual(first);
  await app.expectConsistent();
});

test('同じ classId・同じ方針の改訂版を読むと同じ作業スペースのまま問題文が変わり、書いたタブは残り、足された問題だけタブが増える', async ({
  page,
}) => {
  const app = new EditorApp(page);
  await openPractice(app);
  await loadClassPackage(app);
  await expect(page).toHaveURL(new RegExp(`${TAKE_HOME_PATH}$`));
  await app.typeCode('int keep_me;');
  await app.waitForSynced();
  const before = await tabContents(app);
  expect(before.map((t) => t.filename)).toEqual(['p1.c', 'p2.c']);

  // 改訂: p1 の問題文を変え、p3 を足す。方針は「持ち帰り」を明示 (方針の無い初版と同じ作業スペース)
  const original = sampleClassPackage();
  const [p1, p2] = original.bundle.problems;
  const revised = {
    ...original,
    policy: CLASS_POLICIES.takeHome,
    bundle: {
      ...original.bundle,
      problems: [
        { ...p1!, statement: '# 問題1 改訂版\n差を出力せよ。' },
        p2!,
        { problemId: 'p3', statement: '# 問題3' },
      ],
    },
  };
  await markDocument(page);
  await loadClassPackage(app, classPackageFile(revised));
  expect(await isSameDocument(page)).toBe(true);
  await expect(page).toHaveURL(new RegExp(`${TAKE_HOME_PATH}$`));

  const after = await tabContents(app);
  expect(after.map((t) => t.filename)).toEqual(['p1.c', 'p2.c', 'p3.c']);
  // 書いていたタブは作り直さない (同じ id・同じ中身)
  expect(after.slice(0, 2)).toEqual(before);
  // 足された問題のタブが開き、その問題文が出る
  expect((await app.tabs()).find((t) => t.active)?.filename).toBe('p3.c');
  await expect(page.locator('#problem-body')).toContainText('問題3');
  // 書いていたタブの問題文は改訂版に変わっている
  await app.switchToTab(before[0]!.id);
  await expect(page.locator('#problem-body')).toContainText('改訂版');
  await app.expectConsistent();

  await app.waitForSynced();
  const zipPath = await app.exportViaLogButton();
  expect([...(await readAllProofEvents(zipPath)).keys()]).toHaveLength(3);
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);
});

test('旧来の /class の記録は、問題を読み込んで作業スペースで書いても書き換わらず、/class を開き直すと復元される', async ({
  page,
}) => {
  const app = new EditorApp(page);
  // #646 より前のように /class で書いた記録を作る (ウェルカム画面の「新規ファイル」で開いたタブ)
  await app.openModeFresh('class', { screenShare: 'share', waitReady: false });
  await waitDialogOpen(app, 'welcome');
  await page.locator('#welcome-new-file').click();
  await app.waitReady();
  await app.typeCode('int legacy_class;');
  await app.waitForSynced();
  const legacyTabs = await tabContents(app);

  // 方針の無い .tcclass は、/class からは「教室で実施」の作業スペースで開く (#646 の決定 4)
  await loadClassPackage(app);
  await expect(page).toHaveURL(new RegExp(`${workspacePath(SAMPLE_CLASS_ID, CLASS_POLICIES.classroom)}$`));
  const legacyDbBefore = await dumpDatabase(page, 'typedcode-session-class');
  const legacyKeysBefore = await legacyKeys(page);
  expect(legacyDbBefore).not.toBeNull();

  // 作業スペースで書いて export する。proof の mode は方針から決まる (教室で実施 = class)
  await app.typeCode('int in_workspace;');
  await app.waitForSynced();
  const zipPath = await app.exportViaLogButton();
  expect((await readProofJson(zipPath)).mode).toBe('class');
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);

  // 作業スペースは自分の保存領域に書き、旧来の DB とキーには触らない
  const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
  expect(dbs).toEqual(
    expect.arrayContaining(['typedcode-session-class', 'typedcode-session-w:class:2026-algo-week3:classroom'])
  );
  expect(await dumpDatabase(page, 'typedcode-session-class')).toBe(legacyDbBefore);
  expect(await legacyKeys(page)).toEqual(legacyKeysBefore);

  // 旧来の URL を開き直すと、/class のタブが中身ごと戻る (作業スペースのタブは混ざらない)
  await app.waitForSynced();
  await page.goto('/class');
  const share = page.locator('.screen-share-choice-dialog [data-choice="share"]');
  await share.waitFor({ state: 'visible', timeout: 30_000 });
  await share.click();
  await waitResumed(app);
  expect(await tabContents(app)).toEqual(legacyTabs);
  await app.expectConsistent();
});

test('形の崩れた作業スペースの URL はエディタを起動せず not-found になる', async ({ page }) => {
  const app = new EditorApp(page);
  for (const path of ['/w/class/a', '/w/class/a/unknown-policy', '/w/exam/a/classroom']) {
    await page.goto(path);
    await expect.poll(() => app.appState()).toBe('not-found');
    await expect(page.locator('.monaco-editor')).toHaveCount(0);
  }
});
