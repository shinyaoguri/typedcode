import { test, expect, type Page, type Request } from '@playwright/test';
import { EditorApp } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * C / C++ の実行系 (Wasmer + clang) は最初の C / C++ の実行まで取らない (#617)。
 *
 * - JS だけの起動・編集・実行・export では、Wasmer の SDK (JS と wasm) も clang の webc も要求しない
 * - 最初の C の実行で初めて取りに行く。clang の取得に失敗した実行は error で終わり、読み込みの表示を残さず、
 *   ランタイムの表示 (`#runtime-state-indicator[data-runtime-state]`) を not-ready に戻す。次の実行は取り直す
 *
 * clang の webc の取得先 (assets.typedcode.dev) は route で止めるので、外部の配信に依存しない (PR ゲート)。
 * 実物の clang で hello を 2 回実行し、取得と初期化が 1 回で済むことは code-execution-c-python.spec.ts の
 * `@nightly`、本番ビルドの network は production-build.spec.ts が見る。
 */

const TERMINAL = '#xterm-container';
const CLANG_ORIGIN = 'https://assets.typedcode.dev/**';

/** C / C++ の実行系に属する取得 (dev サーバは node_modules と src をそのまま配る) */
const C_RUNTIME_REQUESTS: readonly RegExp[] = [
  /@wasmer\/sdk/, // SDK の JS (dist/index.js・worker・glue)
  /wasmer_sdk_js_bg\.wasm/, // SDK の wasm 本体
  /\.webc(\?|$)/, // clang
  /\/executors\/c\/CExecutor\.ts/,
  /\/executors\/cpp\/CppExecutor\.ts/,
];

function isCRuntimeRequest(url: string): boolean {
  return C_RUNTIME_REQUESTS.some((re) => re.test(url));
}

/** ページの要求をすべて記録する (route で止めた要求も含む) */
function recordRequests(page: Page): Request[] {
  const requests: Request[] = [];
  page.on('request', (request) => requests.push(request));
  return requests;
}

async function execState(page: Page) {
  return page.locator(TERMINAL).evaluate((el) => ({
    state: el.getAttribute('data-exec-state'),
    run: Number(el.getAttribute('data-exec-run') ?? '0'),
    outcome: el.getAttribute('data-exec-outcome'),
  }));
}

/** Run を押し、その run が終わる (data-exec-state=idle) まで待って outcome を返す */
async function runAndWait(page: Page, timeout = 60_000): Promise<string | null> {
  const run = (await execState(page)).run + 1;
  await page.locator('#run-code-btn').click();
  await expect(page.locator(TERMINAL)).toHaveAttribute('data-exec-run', String(run), { timeout: 15_000 });
  await expect
    .poll(
      async () => {
        const s = await execState(page);
        return s.run === run && s.state === 'idle';
      },
      { timeout }
    )
    .toBe(true);
  return (await execState(page)).outcome;
}

test('JS だけの起動・編集・実行・export では Wasmer の SDK・wasm も clang の webc も要求しない (#617)', async ({
  page,
}) => {
  // 万一取りに行っても外部へは出さない (要求そのものは記録に残る)
  await page.route(CLANG_ORIGIN, (route) => route.abort('blockedbyclient'));
  const requests = recordRequests(page);

  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('javascript');
  await app.typeCode('console.log("js-only-" + (6 * 7));');
  expect(await runAndWait(page)).toBe('success');

  await app.waitForSynced();
  const zipPath = await app.exportAllTabs();
  const result = runVerifyCli(zipPath, ['--mode', 'fast']);
  expect(result.passed, result.stdout + result.stderr).toBe(true);

  await page.waitForLoadState('networkidle');
  const leaked = requests.map((r) => r.url()).filter(isCRuntimeRequest);
  expect(leaked, 'JS だけの利用で取得した C / C++ の実行系').toEqual([]);
});

test('最初の C の実行で初めて clang を取りに行き、取得に失敗した実行は error で終わり、次の実行で取り直す (#617)', async ({
  page,
}) => {
  let clangFetches = 0;
  await page.route(CLANG_ORIGIN, (route) => {
    clangFetches++;
    return route.fulfill({ status: 503, body: 'unavailable' });
  });
  const requests = recordRequests(page);

  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.setLanguage('c');
  await app.typeCode('int main(void) { return 0; }');
  await app.waitForSynced();
  const indicator = page.locator('#runtime-state-indicator');
  await expect(indicator).toHaveAttribute('data-runtime-state', 'not-ready');
  // C のタブを開いて打っただけでは取りに行かない
  expect(requests.map((r) => r.url()).filter(isCRuntimeRequest)).toEqual([]);
  expect(clangFetches).toBe(0);

  expect(await runAndWait(page)).toBe('error');
  expect(clangFetches).toBe(1);
  await expect(page.locator('#clang-loading-overlay')).toBeHidden();
  await expect(indicator).toHaveAttribute('data-runtime-state', 'not-ready');

  // 失敗した初期化は残らず、次の実行が取り直す
  expect(await runAndWait(page)).toBe('error');
  expect(clangFetches).toBe(2);
  await expect(page.locator('#clang-loading-overlay')).toBeHidden();
  await expect(indicator).toHaveAttribute('data-runtime-state', 'not-ready');
});
