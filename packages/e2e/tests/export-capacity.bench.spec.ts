import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { test, type Browser, type Download, type Page } from '@playwright/test';
import { EditorApp } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * export の容量の測定 (`@bench`, #628)。**何も assert しない**。数値を吐くだけ (posw.bench.spec.ts と同じ位置づけ)。
 *
 * 長時間セッションの export で、`ProofExporter` が proof を `JSON.stringify(proofWithContent, null, 2)` で 1 本の文字列に
 * してから ZIP に入れる経路が、どの件数まで成り立つかを実ブラウザ (Chromium) の中の本物の export の経路で測る。
 *
 * - **実操作** (`real typing session`): 実エディタに実キーストロークで打鍵し、本物の「ダウンロード」で export する。
 *   イベント数・打鍵数・bytes/event (インデントあり / 無し)・各段階の時間を採り、できた ZIP を verify-cli で検証する
 *   (正の対照: 測定の経路が本物の export と同じであることの確認。ZIP は OS の
 *   一時ディレクトリに残し、結果に置き場を書く)。打鍵数は `CAP_REAL_CHARS` (既定 600)
 * - **段階的な水増し** (`padded ladder`): 実際に打鍵した短い列を dev フック `__tcTestCapacity.pad` で指定の件数まで
 *   複製し (packages/editor/src/export/capacityPadding.ts)、同じ本物の「ダウンロード」で export する。**水増しした proof は
 *   容量の測定用で、ハッシュチェーンが繋がらず検証に通らない**。ZIP は保存せず、大きさと時間だけを記録する
 * - 段階の時間: 構築 = `typingProof.exportProof` (dev フックで計る)、文字列化 = proof を引数にした `JSON.stringify(…, null, 2)`
 *   (ページの `JSON.stringify` を包んで計る。失敗したらその場でインデント無しの文字列化も試す)、ZIP = exporter のログ
 *   `Generating ZIP` から `ZIP generated` まで
 * - ピークメモリ: レンダラのプロセスの RSS を Node 側から `ps` で 250ms ごとに読んだ最大値 (メインスレッドが止まっていても
 *   読める)。V8 のヒープは export の前後の `performance.memory` だけ (`--enable-precise-memory-info`)
 * - メモリ予算 (`CAP_BUDGET_MB`、既定 6144): ある件数のピークが予算を超えるか、どこかの段階が失敗したら、それより大きい件数は
 *   回さない。`CAP_HARD_MB` (既定 16384) を超えたらその場でページを閉じて打ち切る
 * - 件数は `CAP_STEPS` (カンマ区切り)、水増しの contentSnapshot の末尾の全文は `CAP_FINAL_SNAPSHOT_CHARS` (既定 20000)
 *
 * 実行は `npm run bench:export -w @typedcode/e2e`。結果は `packages/e2e/bench/` (gitignore 済み) に JSON で残り、
 * 標準出力にも 1 行の JSON で出る。
 */

/** dev フック `window.__tcTestCapacity` (packages/editor/src/export/devCapacityHook.ts) の写し */
interface CapacityHook {
  pad(request: { targetEvents: number; finalSnapshotChars?: number }): Promise<{
    baseEvents: number;
    bodyStart: number;
    events: number;
    checkpoints: number;
  }>;
  timeExportProof(): void;
  constructTimings: Array<{ ms: number; error?: string }>;
}

declare global {
  interface Window {
    __tcTestCapacity?: CapacityHook;
  }
}

const OUT = fileURLToPath(new URL('../bench/', import.meta.url));
const REAL_CHARS = Number(process.env.CAP_REAL_CHARS ?? 600);
const BASE_CHARS = Number(process.env.CAP_BASE_CHARS ?? 400);
const STEPS = (process.env.CAP_STEPS ?? '18000,36000,72000,144000,250000,350000,450000,500000,550000,700000')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const FINAL_SNAPSHOT_CHARS = Number(process.env.CAP_FINAL_SNAPSHOT_CHARS ?? 20_000);
const BUDGET_MB = Number(process.env.CAP_BUDGET_MB ?? 6144);
const HARD_MB = Number(process.env.CAP_HARD_MB ?? 16_384);
const EXPORT_TIMEOUT_MS = Number(process.env.CAP_EXPORT_TIMEOUT_MS ?? 20 * 60_000);
/** 実操作の ZIP を verify-cli にかけるモード。既定は件数が小さければ full、大きければ fast */
const VERIFY_MODE = process.env.CAP_VERIFY_MODE;

test.use({
  launchOptions: { args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] },
});

const run = promisify(execFile);
const MB = 1024 * 1024;

function round(n: number, d = 1): number {
  const k = 10 ** d;
  return Math.round(n * k) / k;
}

function environment(browser: Browser) {
  return {
    machine: `${cpus()[0]?.model ?? 'unknown'} x${cpus().length}, ${round(totalmem() / 1024 / MB)} GiB`,
    os: `${platform()} ${release()}`,
    browser: `chromium ${browser.version()}`,
    headless: !process.env.HEADED,
    node: process.version,
  };
}

// ---------------------------------------------------------------------------
// メモリ (レンダラの RSS)

async function rendererPids(browser: Browser): Promise<number[]> {
  const session = await browser.newBrowserCDPSession();
  try {
    const info = (await session.send('SystemInfo.getProcessInfo')) as {
      processInfo: Array<{ type: string; id: number }>;
    };
    return info.processInfo.filter((p) => p.type === 'renderer').map((p) => p.id);
  } finally {
    await session.detach();
  }
}

class RssSampler {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  peakMb = 0;
  overHard = false;

  constructor(
    private readonly pids: number[],
    private readonly onHard: () => void
  ) {}

  async read(): Promise<number> {
    if (this.pids.length === 0) return 0;
    try {
      const { stdout } = await run('ps', ['-o', 'rss=', '-p', this.pids.join(',')]);
      const kb = stdout
        .split('\n')
        .map((l) => Number(l.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
      return Math.max(0, ...kb) / 1024;
    } catch {
      return 0; // プロセスが消えた (クラッシュ・閉じた)
    }
  }

  start(): void {
    this.timer = setInterval(async () => {
      if (this.busy) return;
      this.busy = true;
      const mb = await this.read();
      this.peakMb = Math.max(this.peakMb, mb);
      if (mb > HARD_MB && !this.overHard) {
        this.overHard = true;
        this.onHard();
      }
      this.busy = false;
    }, 250);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

// ---------------------------------------------------------------------------
// 打鍵

/** `v12 = v12 + 7;` の行を chars 文字ぶん作る。括弧・引用符を含めない (自動で閉じる文字を挟まない)。行末は `;` で補完を閉じる */
function codeText(chars: number): string {
  let s = '';
  for (let i = 1; s.length < chars; i++) s += `v${i % 97} = v${i % 97} + ${i % 10};\n`;
  return s.slice(0, chars);
}

async function pending(app: EditorApp): Promise<{ total: number; pending: number }> {
  const snap = await app.snapshot();
  const tab = snap.tabs.find((x) => x.id === snap.activeTabId);
  return { total: tab?.totalEvents ?? 0, pending: tab?.pendingCount ?? 0 };
}

async function drain(app: EditorApp): Promise<void> {
  for (;;) {
    if ((await pending(app)).pending === 0) return;
    await app.page.waitForTimeout(200);
  }
}

/** 200 文字ずつ打ち、PoSW の backlog が 1,000 件を超えないよう待ちながら進める。打った打鍵数を返す */
async function typeChunked(app: EditorApp, text: string): Promise<{ keys: number; focusLost: number }> {
  await app.focusEditor();
  let keys = 0;
  let focusLost = 0;
  for (let i = 0; i < text.length; i += 200) {
    // フォーカスがエディタの外へ出たまま打つと、打鍵がボタンなどへ届く (言語切替のボタンに Enter が届いてページが
    // 読み直された実例がある)。チャンクごとに確かめ、外れていたら数えて末尾へ戻す
    const inEditor = await app.page.evaluate(() => !!document.activeElement?.closest('.monaco-editor'));
    if (!inEditor) {
      focusLost++;
      await app.focusEditor();
      await app.page.keyboard.press('ControlOrMeta+End');
    }
    const chunk = text.slice(i, i + 200);
    await app.page.keyboard.type(chunk);
    keys += chunk.length;
    while ((await pending(app)).pending > 1000) await app.page.waitForTimeout(200);
  }
  await drain(app);
  return { keys, focusLost };
}

// ---------------------------------------------------------------------------
// export の計測

interface StageLog {
  stringify?: { ms: number; length?: number; error?: string };
  compactOnFailure?: { ms: number; length?: number; error?: string };
  zipStart?: number;
  zipEnd?: number;
  zipSize?: number;
  failure?: string;
}

/** ページの JSON.stringify と console を包んで、文字列化と ZIP の段階を記録する。 */
async function instrument(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __cap: StageLog; __capJson: string | null };
    w.__cap = {};
    w.__capJson = null;
    const orig = JSON.stringify;
    JSON.stringify = function (this: unknown, value: unknown, replacer?: unknown, space?: unknown) {
      const isProof =
        space === 2 && value !== null && typeof value === 'object' && 'typingProofData' in value && 'content' in value;
      if (!isProof) return orig.call(JSON, value, replacer as never, space as never);
      const t0 = performance.now();
      try {
        const s = orig.call(JSON, value, replacer as never, space as never);
        w.__cap.stringify = { ms: performance.now() - t0, length: s.length };
        // exporter も同じ文字列を自己検証のために保持する (proofJsons) ので、ここで持っても寿命は変わらない
        w.__capJson = s;
        return s;
      } catch (e) {
        w.__cap.stringify = { ms: performance.now() - t0, error: String(e) };
        const t1 = performance.now();
        try {
          const c = orig.call(JSON, value);
          w.__cap.compactOnFailure = { ms: performance.now() - t1, length: c.length };
        } catch (e2) {
          w.__cap.compactOnFailure = { ms: performance.now() - t1, error: String(e2) };
        }
        throw e;
      }
    } as typeof JSON.stringify;
    const log = console.log.bind(console);
    console.log = (...args: unknown[]) => {
      const m = String(args[0]);
      if (m.startsWith('[Export] Generating ZIP')) w.__cap.zipStart = performance.now();
      if (m.startsWith('[Export] ZIP generated')) {
        w.__cap.zipEnd = performance.now();
        w.__cap.zipSize = Number(args[1]);
      }
      log(...args);
    };
    const error = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      if (String(args[0]).startsWith('[TypedCode] ZIP export failed')) w.__cap.failure = String(args[1]);
      error(...args);
    };
  });
  await page.evaluate(() => window.__tcTestCapacity?.timeExportProof());
}

interface HeapInfo {
  usedMb: number;
  limitMb: number;
}

async function heap(page: Page): Promise<HeapInfo> {
  return page.evaluate(() => {
    (globalThis as { gc?: () => void }).gc?.();
    const m = (performance as unknown as { memory: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    return { usedMb: m.usedJSHeapSize / 1024 / 1024, limitMb: m.jsHeapSizeLimit / 1024 / 1024 };
  });
}

interface ExportMetrics {
  outcome: 'ok' | 'failed' | 'crashed' | 'aborted-hard-cap' | 'timeout';
  failedStage?: 'construct' | 'stringify' | 'zip' | 'unknown';
  error?: string;
  totalMs: number;
  constructMs?: number;
  stringifyMs?: number;
  zipMs?: number;
  jsonChars?: number;
  jsonCompactChars?: number;
  jsonUtf8Bytes?: number;
  compactOnFailure?: StageLog['compactOnFailure'];
  zipBytes?: number;
  heapBefore?: HeapInfo;
  rssBeforeMb: number;
  rssPeakMb: number;
}

async function proceedSelfReview(page: Page): Promise<void> {
  const proceed = page.locator('.self-review-btn-proceed');
  try {
    await proceed.waitFor({ state: 'visible', timeout: 15_000 });
    await proceed.click();
  } catch {
    /* 出ないモード */
  }
}

/**
 * 「ダウンロード」を押して、ダウンロードか失敗かクラッシュまで待つ。`keepZip` のときだけ ZIP を保存してパスを返す
 * (実操作の正規の proof だけ。水増しの ZIP は残さない)。
 */
async function measureExport(
  browser: Browser,
  page: Page,
  keepZip: boolean
): Promise<{ metrics: ExportMetrics; zipPath?: string }> {
  await instrument(page);
  const heapBefore = await heap(page);
  const pids = await rendererPids(browser);
  let crashed = false;
  page.on('crash', () => {
    crashed = true;
  });
  const sampler = new RssSampler(pids, () => void page.close().catch(() => {}));
  const rssBeforeMb = await sampler.read();
  sampler.start();

  const t0 = Date.now();
  const download = page.waitForEvent('download', { timeout: EXPORT_TIMEOUT_MS }).catch(() => null);
  await page.locator('#download-btn').click();
  await proceedSelfReview(page);
  const failed = page
    .waitForFunction(() => (window as unknown as { __cap: StageLog }).__cap.failure !== undefined, null, {
      timeout: EXPORT_TIMEOUT_MS,
      polling: 1000,
    })
    .then(() => 'failed' as const)
    .catch(() => null);
  const first = await Promise.race([download.then((d) => (d ? ('download' as const) : null)), failed]);
  const totalMs = Date.now() - t0;
  sampler.stop();

  const base = { totalMs, heapBefore, rssBeforeMb: round(rssBeforeMb), rssPeakMb: round(sampler.peakMb) };
  if (sampler.overHard) return { metrics: { ...base, outcome: 'aborted-hard-cap', failedStage: 'unknown' } };
  if (crashed || page.isClosed()) return { metrics: { ...base, outcome: 'crashed', failedStage: 'unknown' } };
  if (first === null) return { metrics: { ...base, outcome: 'timeout', failedStage: 'unknown' } };

  const cap = await page.evaluate(() => (window as unknown as { __cap: StageLog }).__cap);
  const construct = await page.evaluate(() => window.__tcTestCapacity?.constructTimings.at(-1));
  const stages = {
    constructMs: construct ? round(construct.ms) : undefined,
    stringifyMs: cap.stringify ? round(cap.stringify.ms) : undefined,
    zipMs: cap.zipStart !== undefined && cap.zipEnd !== undefined ? round(cap.zipEnd - cap.zipStart) : undefined,
  };

  if (first === 'failed') {
    const failedStage = construct?.error
      ? 'construct'
      : cap.stringify?.error
        ? 'stringify'
        : cap.zipStart !== undefined
          ? 'zip'
          : 'unknown';
    return {
      metrics: {
        ...base,
        ...stages,
        outcome: 'failed',
        failedStage,
        error: cap.failure,
        compactOnFailure: cap.compactOnFailure,
      },
    };
  }

  // 成功: インデント無しの長さ = インデントありの長さ - 文字列の外の空白 (stringify の space は文字列の外にしか空白を足さない)。
  // UTF-8 の大きさも同じ走査で数える
  const sizes = await page.evaluate(() => {
    const w = window as unknown as { __capJson: string | null };
    const s = w.__capJson ?? '';
    let inString = false;
    let ws = 0;
    let utf8 = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      utf8 += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdfff ? 2 : 3; // サロゲート対は 2+2 = 4
      if (inString) {
        if (c === 0x5c) {
          i++;
          utf8 += 1; // エスケープの次の文字は ASCII
        } else if (c === 0x22) inString = false;
      } else if (c === 0x22) inString = true;
      else if (c === 0x20 || c === 0x0a) ws++;
    }
    w.__capJson = null;
    return { chars: s.length, compact: s.length - ws, utf8 };
  });
  const dl = (await download) as Download;
  let zipPath: string | undefined;
  if (keepZip) {
    const dir = mkdtempSync(join(tmpdir(), 'tc-cap-'));
    zipPath = join(dir, dl.suggestedFilename());
    await dl.saveAs(zipPath);
  } else {
    await dl.delete().catch(() => {});
  }
  return {
    metrics: {
      ...base,
      ...stages,
      outcome: 'ok',
      jsonChars: sizes.chars,
      jsonCompactChars: sizes.compact,
      jsonUtf8Bytes: sizes.utf8,
      zipBytes: cap.zipSize,
    },
    zipPath,
  };
}

function save(name: string, result: unknown): void {
  console.log(JSON.stringify(result));
  mkdirSync(OUT, { recursive: true });
  // 同じ条件を何度か回してばらつきを見るので、実行ごとに別のファイルにする
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(`${OUT}${name}-${stamp}.json`, `${JSON.stringify(result, null, 2)}\n`);
}

// ---------------------------------------------------------------------------

test('export capacity: real typing session and verify-cli positive control @bench', async ({ browser }) => {
  test.setTimeout(3 * 60 * 60_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await drain(app);
  // 打鍵の途中でページが読み直されたら、その回は実操作の測定として無効 (結果に残して見分ける)
  const navigations: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations.push(`${new Date().toISOString()} ${frame.url()}`);
  });
  const phases: Record<string, string> = { typingStart: new Date().toISOString() };
  const before = await pending(app);
  const t0 = Date.now();
  const { keys: keystrokes, focusLost } = await typeChunked(app, codeText(REAL_CHARS));
  const typingMs = Date.now() - t0;
  const after = await pending(app);
  phases.typingEnd = new Date().toISOString();

  const { metrics, zipPath } = await measureExport(browser, page, true);
  phases.exportEnd = new Date().toISOString();
  await context.close();
  phases.contextClosed = new Date().toISOString();

  const result: Record<string, unknown> = {
    kind: 'real-typing',
    environment: environment(browser),
    valid: navigations.length === 0,
    navigations,
    focusLost,
    phases,
    keystrokes,
    typingMs,
    eventsBeforeTyping: before.total,
    eventsAfterTyping: after.total,
    eventsPerKeystroke: round((after.total - before.total) / keystrokes, 2),
    export: metrics,
  };
  if (zipPath) {
    const zip = await JSZip.loadAsync(readFileSync(zipPath));
    const name = Object.keys(zip.files).find((n) => n.endsWith('_proof.json')) as string;
    const text = await zip.files[name]!.async('string');
    const proof = JSON.parse(text) as { proof: { events: Array<{ type: string }> }; checkpoints?: unknown[] };
    const events = proof.proof.events;
    const compact = JSON.stringify(proof);
    const byType: Record<string, { count: number; compactBytes: number }> = {};
    for (const e of events) {
      const entry = byType[e.type] ?? { count: 0, compactBytes: 0 };
      byType[e.type] = entry;
      entry.count++;
      entry.compactBytes += Buffer.byteLength(JSON.stringify(e));
    }
    const mode = VERIFY_MODE ?? (events.length > 20_000 ? 'fast' : 'full');
    const tv = Date.now();
    const cli = runVerifyCli(zipPath, ['--mode', mode]);
    phases.verified = new Date().toISOString();
    Object.assign(result, {
      proofEvents: events.length,
      checkpoints: proof.checkpoints?.length ?? 0,
      contentChars: (JSON.parse(text) as { content: string }).content.length,
      jsonBytesIndented: Buffer.byteLength(text),
      jsonBytesCompact: Buffer.byteLength(compact),
      bytesPerEventIndented: round(Buffer.byteLength(text) / events.length),
      bytesPerEventCompact: round(Buffer.byteLength(compact) / events.length),
      byType: Object.fromEntries(
        Object.entries(byType)
          .sort((a, b) => b[1].count - a[1].count)
          .map(([k, v]) => [k, { ...v, avgCompactBytes: round(v.compactBytes / v.count) }])
      ),
      positiveControl: {
        verifyMode: mode,
        passed: cli.passed,
        exitCode: cli.exitCode,
        ms: Date.now() - tv,
        tail: cli.stdout.split('\n').slice(-12).join('\n'),
      },
      // 実操作の正規の proof なので残す (別のモードで検証し直せるように)。置き場は OS の一時ディレクトリ
      zipPath,
    });
  }
  save(`export-capacity-real-${REAL_CHARS}`, result);
});

test('export capacity: padded ladder (capacity-only data, not a valid proof) @bench', async ({ browser }) => {
  test.setTimeout(6 * 60 * 60_000);
  const steps: unknown[] = [];
  const result = {
    kind: 'padded-ladder (capacity measurement only; padded proofs do not verify)',
    environment: environment(browser),
    budgetMb: BUDGET_MB,
    hardMb: HARD_MB,
    baseChars: BASE_CHARS,
    finalSnapshotChars: FINAL_SNAPSHOT_CHARS,
    steps,
    stoppedBecause: 'all steps done',
  };
  for (const target of STEPS) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const app = new EditorApp(page);
    await app.openCasualFresh();
    await drain(app);
    await typeChunked(app, codeText(BASE_CHARS));
    const tp = Date.now();
    const pad = await page.evaluate(
      (req) => {
        const hook = window.__tcTestCapacity;
        if (!hook) throw new Error('__tcTestCapacity not available (dev hook missing)');
        return hook.pad(req);
      },
      { targetEvents: target, finalSnapshotChars: FINAL_SNAPSHOT_CHARS }
    );
    const padMs = Date.now() - tp;
    const { metrics } = await measureExport(browser, page, false);
    await context.close().catch(() => {});
    const step = {
      targetEvents: target,
      pad: { ...pad, ms: padMs },
      ...metrics,
      bytesPerEventIndented: metrics.jsonUtf8Bytes ? round(metrics.jsonUtf8Bytes / pad.events) : undefined,
      bytesPerEventCompact: metrics.jsonCompactChars ? round(metrics.jsonCompactChars / pad.events) : undefined,
    };
    steps.push(step);
    console.log(JSON.stringify(step));
    if (metrics.outcome !== 'ok') {
      result.stoppedBecause = `${target}: ${metrics.outcome} (${metrics.failedStage ?? '-'})`;
      break;
    }
    if (metrics.rssPeakMb > BUDGET_MB) {
      result.stoppedBecause = `${target}: renderer RSS peak ${metrics.rssPeakMb} MB > budget ${BUDGET_MB} MB`;
      break;
    }
  }
  save(`export-capacity-ladder-${STEPS[0]}-${STEPS[STEPS.length - 1]}`, result);
});
