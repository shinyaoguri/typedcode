import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, type Page } from '@playwright/test';
import { EditorApp } from './helpers/app.js';

/**
 * 記録側 PoSW のベンチ (`@bench`, #241 / ADR-0045)。**何も assert しない**。数値を吐くだけ。
 *
 * 実エディタ (casual) を開き、打鍵とマウス移動を一定のペースで流して、PoSW の処理待ち
 * (`__tcTestSnapshot()` の `pendingCount` = backlog) が増え続けるかを見る。あわせて、遅延なしの打鍵で
 * backlog を作り、掃ける速さ (スループット、件/秒) を測る。
 *
 * - 通常の E2E と CI のシャードからは playwright.config.ts の `grepInvert` で外してある (`BENCH=1` のときだけ含める)
 * - 実行は `npm run bench:posw -w @typedcode/e2e`。結果は `packages/e2e/bench/` (gitignore 済み) に JSON で残り、
 *   標準出力にも 1 行の JSON で出る
 * - 低速 CPU の模擬 (`factor`): CDP の `Emulation.setCPUThrottlingRate` は**メインスレッドにしか効かず、dedicated
 *   Worker には効かない** (Worker のターゲットへ送ると "Operation is only supported for pages, not workers" で拒否される)。
 *   そこでメインスレッドには CDP で factor 倍を掛け、PoSW の Worker には「1 リクエストの処理時間 d を測り、応答を返す前に
 *   (factor - 1)·d だけ busy-wait する」ラッパーを route で差し込む。Worker のスレッドの占有時間が factor 倍になる
 *   (製品コードは変えない)
 * - `BENCH_ITERATIONS` を渡すと、Worker が受け取る反復数をその値に書き換えて測る (反復数を変えたときの見積もり用。
 *   できる proof は検証に通らない)
 * - 1 文字の打鍵は keyDown・keyUp・contentChange・cursorPositionChange・selectionChange の 5 件になる
 */

/** 低速 CPU の倍率。1 = 手元の CPU のまま。 */
const FACTORS = [1, 4] as const;
/** 一定ペースの 1 区間の長さ。 */
const PACED_MS = 20_000;
/** [打鍵 (文字/秒), マウス (件/秒)]。マウスは MouseTracker の間引き (100ms) で最大 10 件/秒。 */
const PACES: ReadonlyArray<readonly [number, number]> = [
  [2, 0],
  [4, 0],
  [0, 10],
  [4, 10],
];
const ITERATIONS = process.env.BENCH_ITERATIONS ? Number(process.env.BENCH_ITERATIONS) : undefined;
const OUT = fileURLToPath(new URL('../bench/', import.meta.url));

interface Sample {
  t: number;
  total: number;
  pending: number;
}

async function sample(page: Page, t0: number): Promise<Sample> {
  const snap = await new EditorApp(page).snapshot();
  const tab = snap.tabs.find((x) => x.id === snap.activeTabId);
  return { t: Date.now() - t0, total: tab?.totalEvents ?? 0, pending: tab?.pendingCount ?? 0 };
}

/** backlog が 0 になるまで 100ms ごとに読む。 */
async function drain(page: Page, t0: number): Promise<Sample[]> {
  const out: Sample[] = [];
  for (;;) {
    const s = await sample(page, t0);
    out.push(s);
    if (s.pending === 0) return out;
    await page.waitForTimeout(100);
  }
}

/** PoSW の Worker のスクリプトに、低速 CPU の模擬と反復数の書き換えを足す (上の doc)。 */
async function patchPoswWorker(page: Page, factor: number, iterations: number | undefined): Promise<void> {
  if (factor === 1 && iterations === undefined) return;
  await page.route(/poswWorker\.ts/, async (route) => {
    const res = await route.fetch();
    const wrapper = `
;(() => {
  const factor = ${factor};
  const iterations = ${iterations ?? 'undefined'};
  const inner = self.onmessage;
  const post = self.postMessage.bind(self);
  let started = 0;
  self.postMessage = (msg) => {
    const until = performance.now() + (performance.now() - started) * (factor - 1);
    while (performance.now() < until) {}
    post(msg);
  };
  self.onmessage = (e) => {
    started = performance.now();
    return inner(iterations === undefined ? e : { data: { ...e.data, iterations } });
  };
})();
`;
    await route.fulfill({ response: res, body: (await res.text()) + wrapper });
  });
}

/** 遅延なしで打鍵して backlog を作り、掃ける速さを測る。 */
async function saturation(page: Page) {
  const t0 = Date.now();
  const burst = 'int main(void) { return 0; } // 0123456789';
  await page.keyboard.type(burst);
  const d = await drain(page, t0);
  const first = d[0] as Sample;
  const last = d[d.length - 1] as Sample;
  return {
    chars: burst.length,
    events: last.total - first.total + first.pending,
    throughputEventsPerSec: round(((last.total - first.total) / Math.max(1, last.t - first.t)) * 1000),
  };
}

/** 打鍵 cps 文字/秒とマウス mouseHz 件/秒を同時に流し、backlog の推移を読む。 */
async function paced(page: Page, cps: number, mouseHz: number) {
  const box = await page.locator('.monaco-editor .view-lines').first().boundingBox();
  const t0 = Date.now();
  const start = await sample(page, t0);
  const samples: Sample[] = [start];
  let stop = false;
  let chars = 0;
  const text = 'abcdefghij klmnopqrst ';
  const typing = (async () => {
    while (cps > 0 && !stop) {
      await page.keyboard.type(text[chars++ % text.length] as string);
      await page.waitForTimeout(1000 / cps);
    }
  })();
  const mouse = (async () => {
    for (let i = 1; mouseHz > 0 && box && !stop; i++) {
      await page.mouse.move(box.x + 50 + ((i * 37) % 300), box.y + 50 + ((i * 53) % 200));
      await page.waitForTimeout(1000 / mouseHz);
    }
  })();
  const sampler = (async () => {
    while (!stop) {
      samples.push(await sample(page, t0));
      await page.waitForTimeout(250);
    }
  })();
  await page.waitForTimeout(PACED_MS);
  stop = true;
  await Promise.all([typing, mouse, sampler]);
  const end = await sample(page, t0);
  const tail = await drain(page, t0);
  const drained = tail[tail.length - 1] as Sample;
  const arrived = end.total + end.pending - (start.total + start.pending);
  return {
    cps,
    mouseHz,
    chars,
    durationMs: end.t,
    arrivedEvents: arrived,
    arrivalEventsPerSec: round((arrived / end.t) * 1000),
    maxPending: Math.max(end.pending, ...samples.map((s) => s.pending)),
    pendingAtEnd: end.pending,
    drainMsAfterEnd: drained.t - end.t,
    /** 2 秒ごとの backlog。単調に増えていれば処理が入力に追いついていない */
    pendingEvery2s: samples.filter((_, i) => i % 8 === 0).map((s) => s.pending),
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

for (const factor of FACTORS) {
  test(`recording-side PoSW throughput and backlog at ${factor}x CPU @bench`, async ({ browser }) => {
    test.setTimeout(600_000);
    const context = await browser.newContext();
    const page = await context.newPage();
    await patchPoswWorker(page, factor, ITERATIONS);
    const app = new EditorApp(page);
    await app.openCasualFresh();
    await app.focusEditor();
    await drain(page, Date.now());
    if (factor !== 1) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: factor });
    }

    const result = {
      factor,
      iterations: ITERATIONS ?? 'POSW_ITERATIONS',
      browser: browser.version(),
      saturation: await saturation(page),
      paced: [] as Awaited<ReturnType<typeof paced>>[],
    };
    for (const [cps, hz] of PACES) result.paced.push(await paced(page, cps, hz));

    console.log(JSON.stringify(result));
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}posw-${factor}x-${ITERATIONS ?? 'default'}.json`, `${JSON.stringify(result, null, 2)}\n`);
    await context.close();
  });
}
