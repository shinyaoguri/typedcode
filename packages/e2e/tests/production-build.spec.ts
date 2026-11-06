import { basename } from 'node:path';
import { test, expect } from '@playwright/test';
import { EditorApp, listProofEntries } from './helpers/app.js';
import { VerifyWebApp } from './helpers/verifyWeb.js';

/**
 * 本番ビルド (vite build の出力) に対するスモーク。
 *
 * 他の spec はすべて vite dev サーバに対して走るため、**チャンク分割や
 * バンドル変換に起因する退行を原理的に検出できない**。実際に #255 では
 * `vite-plugin-top-level-await` が monaco の関数巻き上げを壊し、本番ビルドの
 * エディタが一切起動しない状態で CI が緑のまま main に載った。
 *
 * この spec だけは `vite preview` (= dist の配信) を対象に、専用の
 * `playwright.build.config.ts` で実行する (`npm run test:build -w @typedcode/e2e`)。
 * 既定の `playwright.config.ts` は testIgnore でこのファイルを外している
 * (dev サーバに対して走らせても目的の退行を検出できないため)。
 *
 * オラクルは「console / pageerror が出ない」「Monaco が実際にマウントされる」
 * 「打鍵がエディタに入る」の 3 点、dev フック (`__tcTestInsertBlock` / `__tcTestSnapshot`) が dist に無いこと、verify の本番ビルド (`/verify/` 配下) が proof を読んで
 * 状態契約の属性を出すこと。重い round-trip と判定の中身 (Web↔CLI パリティ) は dev 側の
 * spec (verify-web-*.spec.ts) が担うので、ここには増やさない (AGENTS.md「CI 時間を意識」)。
 * dist には dev フックが無いので、dev 限定 API に依存しないこと。
 */
test('production build: エディタが console エラーなくマウントし打鍵できる', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  // Cloudflare Web Analytics のビーコン (cloudflareinsights.com) は preview には
  // 存在しないが、将来 dist に混ざっても本件と無関係なので除外しておく。
  const isIrrelevant = (text: string) => /cloudflareinsights\.com|cdn-cgi\/rum/.test(text);

  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isIrrelevant(msg.text())) consoleErrors.push(msg.text());
  });
  // Uncaught TypeError はここに来る (#255 の `Class extends value undefined` / `Le is not a function`)。
  page.on('pageerror', (err) => {
    if (!isIrrelevant(err.message)) pageErrors.push(err.message);
  });

  await page.goto('/casual');

  // ① Monaco が実際にマウントされる。#255 では .monaco-editor が生えないまま止まった。
  // ここで落ちると素の TimeoutError になり原因が見えないので、収集済みのエラーを添えて投げ直す。
  const collected = () => `pageerror:\n${pageErrors.join('\n')}\nconsole.error:\n${consoleErrors.join('\n')}`;
  try {
    await page.locator('.monaco-editor .view-lines').first().waitFor({ state: 'visible', timeout: 30_000 });
  } catch (cause) {
    throw new Error(`Monaco がマウントされなかった (#255 と同じ症状)。\n${collected()}`, { cause });
  }

  // ② イベント記録が動いている (#0 humanAttestation で 1 以上になる)。
  await expect
    .poll(
      async () => {
        const txt = (await page.locator('#event-count').textContent()) ?? '0';
        return Number.parseInt(txt.replace(/[^0-9]/g, ''), 10) || 0;
      },
      { timeout: 30_000 }
    )
    .toBeGreaterThan(0);

  // ③ 1 文字打てて、それがエディタに入る。
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.type('int main(){return 0;}');
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('int main');

  // ④ console / page エラーが 1 件も出ていない。これが #255 の再現オラクル。
  expect(pageErrors, collected()).toEqual([]);
  expect(consoleErrors, collected()).toEqual([]);

  // ⑤ E2E 専用の dev フック (main.ts の `import.meta.env.DEV` ガード内) が dist に残っていない。
  // ガードが外れると、本番で任意の一括挿入 (`__tcTestInsertBlock`) や内部状態の読み出しができてしまう (#433)。
  const hooks = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return { insertBlock: typeof w.__tcTestInsertBlock, snapshot: typeof w.__tcTestSnapshot };
  });
  expect(hooks).toEqual({ insertBlock: 'undefined', snapshot: 'undefined' });
});

/**
 * 未知パス (not-found 画面、#644) の初期ロードで取得してはいけないもの (#302)。entry.ts は not-found では
 * main.ts を dynamic import しないので、Monaco の worker・実行系・xterm・Wasmer は 1 つも来ないはず。
 * Monaco 本体は共有 chunk に合流して名前で引けないので、`.monaco-editor` の個数と `editor.worker`
 * (Monaco が生成されると必ず取りに行く) の不在で見る。
 */
const EDITOR_ONLY_ASSETS = [
  /editor\.api/,
  /editor\.worker/,
  /CodeExecutionController/,
  /CTerminal/,
  /wasmer/i,
  /\.wasm$/,
];

test('production build: 未知パスの not-found 画面はエディタ本体を読み込まずに / へのリンクだけを描く', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const requested: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('request', (req) => requested.push(new URL(req.url()).pathname));

  const app = new EditorApp(page);
  await page.goto('/exsm');
  await expect.poll(() => app.appState()).toBe('not-found');
  await expect(page.locator('#not-found-page a')).toHaveAttribute('href', '/');
  // テーマは editor と同じ設定で付く (Playwright の既定の配色は light)。main.ts を読まなくても落とさない
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  // 遅れて来る取得も拾う
  await page.waitForLoadState('networkidle');

  await expect(page.locator('.monaco-editor')).toHaveCount(0);
  const leaked = requested.filter((path) => EDITOR_ONLY_ASSETS.some((re) => re.test(path)));
  expect(leaked, `not-found で取得した URL:\n${requested.join('\n')}`).toEqual([]);
  expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
});

test('production build: / を開くと練習のエディタが直接開き、Monaco は 1 個だけ生成される', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  const workerFetches: string[] = [];
  page.on('request', (req) => {
    if (/editor\.worker/.test(req.url())) workerFetches.push(req.url());
  });

  const app = new EditorApp(page);
  await page.goto('/');
  await app.waitReady();
  await expect.poll(() => app.appState()).toBe('ready');
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'casual');

  await expect(page.locator('.monaco-editor')).toHaveCount(1);
  expect(workerFetches, workerFetches.join('\n')).toHaveLength(1);
  expect(pageErrors, pageErrors.join('\n')).toEqual([]);
});

test('production build: エディタ本体の chunk を取得できないとき、スピナーのまま止めずに起動失敗の画面を出す', async ({
  page,
  request,
}) => {
  // index.html が静的に読む JS (entry と modulepreload) だけを通し、entry.ts が dynamic import する
  // main.ts 側の chunk をすべて落とす (不安定な網で main の chunk が届かない状況)。chunk 名は
  // ビルドで変わるので、名前ではなく index.html から決める。
  const html = await (await request.get('/casual')).text();
  const staticScripts = new Set(
    [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1])
  );
  expect(staticScripts.size, html).toBeGreaterThan(0);
  await page.route('**/assets/*.js', (route) => {
    const path = new URL(route.request().url()).pathname;
    return staticScripts.has(path) ? route.continue() : route.abort();
  });

  const app = new EditorApp(page);
  await page.goto('/casual');
  await expect.poll(() => app.openDialogs(), { timeout: 30_000 }).toEqual(['boot-failure']);
  await expect(page.locator('#boot-failure-reload-btn')).toBeVisible();
  expect(await app.appState()).toBe('initializing');
});

// 直接アクセスで editor が起動する (#302)。casual は先頭のテストが打鍵まで見ている。
for (const [mode, firstState] of [
  ['class', 'ready'],
  ['exam', 'gate'],
] as const) {
  test(`production build: /${mode} に直接アクセスすると editor が起動する`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const app = new EditorApp(page);
    await app.openModeFresh(mode, { screenShare: 'optOut', waitReady: false });
    await expect.poll(() => app.appState(), { timeout: 30_000 }).toBe(firstState);
    await expect(page.locator('html')).toHaveAttribute('data-mode', mode);
    await expect(page.locator('.monaco-editor')).toHaveCount(1);
    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  });
}

test('production build: verify (/verify/) が proof を読んで判定の状態契約を出す', async ({ page, baseURL }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  // proof は本番ビルドの editor で作る (dev フックは使わない)。
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int main(){return 0;}\n');
  const zipPath = await app.exportCurrentTab();
  const names = (await listProofEntries(zipPath)).map((n) => basename(n));
  expect(names.length).toBeGreaterThan(0);

  // deploy と同じ配置: editor の dist の `verify/` (base: '/verify/' でビルドされた verify)。
  const web = new VerifyWebApp(page, new URL('/verify/', baseURL).toString());
  await web.open('fast');
  const states = await web.load([zipPath]);
  expect(states.length, 'ZIP のファイルがサイドバーに並ぶ').toBeGreaterThan(0);

  // 判定の値そのものは dev 側 (verify-web-parity.spec.ts) が CLI と突き合わせる。ここは「本番ビルドでも
  // 検証 Worker が動いて判定まで届き、状態契約の属性が出る」ことだけを見る。
  for (const v of await web.readVerdicts(names)) {
    expect(v.status, JSON.stringify(v)).not.toBe('error');
    expect(['proven', 'partial'], JSON.stringify(v)).toContain(v.integrity);
    expect(v.temporal, JSON.stringify(v)).not.toBeNull();
    expect(['true', 'false'], JSON.stringify(v)).toContain(v.pureTyping);
    expect(['verified', 'partial'], JSON.stringify(v)).toContain(v.level);
  }
  expect(pageErrors, pageErrors.join('\n')).toEqual([]);
});

test('production build: JS の実行が sandbox (iframe 内の Worker) で動き、dev 限定の上限の上書きが効かない', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('javascript');
  await app.focusEditor();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.type('console.log("hello-" + (6*7))');

  // dev ビルドなら 1ms でタイムアウトする上書き。本番ビルドでは読まれない (#290)
  await page.evaluate(() => {
    (window as unknown as { __tcExecLimits?: unknown }).__tcExecLimits = { timeoutMs: 1 };
  });

  // 本番の CSP・COEP (credentialless) の下でも sandbox iframe と Blob Worker が動き、success で終わる
  const terminal = page.locator('#xterm-container');
  await page.locator('#run-code-btn').click();
  await expect(terminal).toHaveAttribute('data-exec-run', '1');
  await expect(terminal).toHaveAttribute('data-exec-state', 'idle', { timeout: 30_000 });
  await expect(terminal).toHaveAttribute('data-exec-outcome', 'success');
  await expect(terminal.locator('.xterm-rows')).toContainText('hello-42');
  await expect(page.locator('iframe[data-code-runner]')).toHaveCount(0);
  expect(pageErrors, pageErrors.join('\n')).toEqual([]);
});

/**
 * @wasmer/sdk の worker と wasm-bindgen の glue は、本番ビルドでだけ壊れる (vite.config.ts の
 * `wasmerSdkBundledWorkers` が差し替えている。editor/AGENTS.md の #364 の項)。dev サーバの C の実行
 * (code-execution-c-python.spec.ts) では検出できないので、ここで本番ビルドの C の hello を実行する。
 * clang の webc (約 100 MB) を外部 (assets.typedcode.dev) から取るので PR ゲートには載せず `@nightly` にする
 * (playwright.build.config.ts の grepInvert。NIGHTLY=1 で含まれる)。
 */
test('production build: @nightly C の hello が Wasmer の clang でコンパイルされて実行され、success で終わる', async ({
  page,
}) => {
  test.setTimeout(360_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('c');
  await app.focusEditor();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  // dev フック (`__tcTestInsertBlock`) は dist に無いので打鍵で入れる。改行の自動インデントを通らないよう 1 行にし、
  // 計算した値を出す (コードの文字列がそのまま出ているのではなく、実行された証拠にする)
  await page.keyboard.type('int printf(const char *, ...);int main(void){printf("hello-c-%d\\n", 6 * 7);return 0;}');

  const terminal = page.locator('#xterm-container');
  await page.locator('#run-code-btn').click();
  await expect(terminal).toHaveAttribute('data-exec-run', '1');
  // 1 回目の実行は Wasmer の初期化と clang の取得を含む
  await expect(terminal).toHaveAttribute('data-exec-state', 'idle', { timeout: 240_000 });
  await expect(terminal).toHaveAttribute('data-exec-outcome', 'success');
  await expect(terminal.locator('.xterm-rows')).toContainText('hello-c-42');
  expect(pageErrors, pageErrors.join('\n')).toEqual([]);
});

/**
 * Python は専用の module Worker (`executors/python/pythonWorker.ts`) で Pyodide を動かし、stdin を
 * SharedArrayBuffer で渡す (#649)。Worker のバンドルと、本番の COOP / COEP の下で SharedArrayBuffer を
 * Worker に渡せることは本番ビルドでしか確かめられないので、入力付きの実行を 1 本ここで回す。
 * Pyodide を jsDelivr から取るので `@nightly`。
 */
test('production build: @nightly Python の input() がターミナルに打った行を読み、success で終わる', async ({
  page,
}) => {
  test.setTimeout(360_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  let dialogs = 0;
  page.on('dialog', (dialog) => {
    dialogs++;
    void dialog.dismiss();
  });

  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('python');
  await app.focusEditor();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  // dev フックは dist に無いので打鍵で入れる。自動インデントを通らないよう 1 行にする
  await page.keyboard.type('a, b = map(int, input().split()); print("sum-" + str(a + b))');

  const terminal = page.locator('#xterm-container');
  await page.locator('#run-code-btn').click();
  await expect(terminal).toHaveAttribute('data-exec-run', '1');
  // 1 回目の実行は Pyodide の取得と初期化を含む。利用者のコードが走り始めてから打つ
  await expect(terminal.locator('.xterm-rows')).toContainText('Running Python...', { timeout: 240_000 });
  await terminal.click();
  await page.keyboard.type('3 5');
  await page.keyboard.press('Enter');

  await expect(terminal).toHaveAttribute('data-exec-state', 'idle', { timeout: 60_000 });
  await expect(terminal).toHaveAttribute('data-exec-outcome', 'success');
  await expect(terminal.locator('.xterm-rows')).toContainText('sum-8');
  expect(dialogs).toBe(0);
  expect(pageErrors, pageErrors.join('\n')).toEqual([]);
});
