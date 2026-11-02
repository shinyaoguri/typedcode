import { writeFile } from 'node:fs/promises';
import type { Browser, BrowserContext, TestInfo } from '@playwright/test';
import fc from 'fast-check';
import { type EditorModel, AddTab, editorCommandArbitraries } from './editorModel.js';
import { PlaywrightEditorDriver } from './playwrightDriver.js';

/**
 * model-based E2E (#436) の実行と失敗の報告。
 *
 * 1 本の列 = 新しいブラウザコンテキストで `openCasualFresh()` → コマンド列 (各手の後にモデルと突き合わせ) →
 * 全タブ export の検証。列ごとにコンテキストを作り直すのは、同じページで `openCasualFresh()` を
 * 繰り返しても前の列の状態が残るため (#446: `/casual?reset` は値の無い `reset` を main.ts が偽と読み、
 * 消去が走らない。各 spec は新しいコンテキストで始まるので普段は表に出ない)。縮約は同じ列を何度も
 * 流し直すので、列どうしが独立でないと縮約が壊れる。#446 が直ったら、1 つのページで
 * `openCasualFresh()` を繰り返す形に戻してよい (戻さなくても正しさは変わらない)。
 * 失敗したら fast-check が操作列を縮約し、シード・path・縮約後の操作列と、同じ列を再実行するコマンドを
 * テスト出力と `model-failure.md` (テストの出力ディレクトリ。nightly はこれを Issue に集める) に出す。
 *
 * 再実行の入口 (環境変数。どのテストでも効く):
 *   FC_SEED / FC_PATH / FC_REPLAY_PATH  fast-check の seed・path と fc.commands の replayPath
 *   FC_STEPS / FC_RUNS                  列の長さ (maxCommands) と本数 (numRuns)
 *   FC_NO_SHRINK=1                      縮約せず最初の失敗で止める (調査用)
 */
export interface ModelRunOptions {
  /** 列ごとに新しいコンテキストを作る元 (config の `use` の設定 = baseURL・クリップボード権限を引き継ぐ) */
  browser: Browser;
  testInfo: TestInfo;
  /** `-g` で再実行するときにこのテストだけを選べる、タイトル中の一意な語 */
  grepToken: string;
  seed: number;
  steps: number;
  runs: number;
  /** 縮約を含めた fast-check の持ち時間。超えたらそこまでの最小の反例で報告する */
  timeLimitMs: number;
  /** `@nightly` のテストか (再実行コマンドに NIGHTLY=1 を付ける) */
  nightly: boolean;
}

/** 環境変数の整数 (無ければ undefined)。 */
export function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer (got ${JSON.stringify(raw)})`);
  return n;
}

export async function runModelBased(o: ModelRunOptions): Promise<void> {
  const path = process.env.FC_PATH || undefined;
  const replayPath = process.env.FC_REPLAY_PATH || undefined;
  let runNo = 0;
  let context: BrowserContext | null = null;
  /** 最後に失敗した列の操作ログ (= 報告する反例の列。縮約は失敗した候補だけを採るので) */
  let failingLog: string[] = [];
  console.log(
    `[model] seed=${o.seed} steps=${o.steps} runs=${o.runs}` +
      (path ? ` path=${path}` : '') +
      (replayPath ? ` replayPath=${replayPath}` : '')
  );

  const property = fc.asyncProperty(
    // size: 'max' で列の長さを maxCommands まで散らす (既定の small だと 15 手を指定しても 10 手前後で終わる)
    fc.commands(editorCommandArbitraries(), { maxCommands: o.steps, size: 'max', replayPath }),
    async (cmds) => {
      runNo += 1;
      // 列ごとに新しいコンテキスト (#446 の回避。上の説明を参照)
      await context?.close();
      context = await o.browser.newContext();
      const driver = new PlaywrightEditorDriver(await context.newPage());
      let model: EditorModel | undefined;
      try {
        await fc.asyncModelRun(async () => {
          model = await driver.start(`#${runNo}`);
          return { model, real: driver };
        }, cmds);
        await finish(model!, driver);
      } catch (e) {
        driver.log(`FAILED: ${errorText(e)}`);
        failingLog = [...driver.lines];
        throw e;
      }
    }
  );

  let details: fc.RunDetails<unknown>;
  try {
    details = await fc.check(property, {
      seed: o.seed,
      numRuns: o.runs,
      path,
      endOnFailure: process.env.FC_NO_SHRINK === '1',
      plugins: [fc.interruptAfterTimeLimit(o.timeLimitMs)],
    });
  } finally {
    await (context as BrowserContext | null)?.close();
  }
  if (details.interrupted) {
    console.log(`[model] interrupted after ${o.timeLimitMs}ms (runs=${details.numRuns}, failed=${details.failed})`);
  }
  if (!details.failed) return;

  const report = formatReport(o, details, failingLog);
  console.log(report);
  const reportPath = o.testInfo.outputPath('model-failure.md');
  await writeFile(reportPath, report);
  await o.testInfo.attach('model-failure.md', { path: reportPath, contentType: 'text/markdown' });
  throw new Error(report);
}

/** 失敗の要約 (expect の差分まで。呼び出し履歴は落とす)。 */
function errorText(e: unknown): string {
  const text = (e instanceof Error ? e.message : String(e)).replace(ANSI, '');
  return text.split('\nCall Log:')[0]!.split('\n').slice(0, 40).join('\n');
}

/**
 * 列の最後: 全タブを export して verify-cli で検証し、proof をモデルと突き合わせる。
 * タブ 0 本 (全部閉じてウェルカム) で終わった列は、ウェルカム画面からタブを 1 本足してから export する
 * (export するものが無いと検証が空振りになるため)。足した手は縮約後の操作列には出ない (操作ログには出る)。
 */
async function finish(model: EditorModel, driver: PlaywrightEditorDriver): Promise<void> {
  if (model.tabs.length === 0) {
    driver.log('finish: no tabs left, adding one from the welcome screen');
    await new AddTab().run(model, driver);
  }
  driver.log('finish: ExportAllTabs()');
  await driver.exportAllTabs(model);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI のエスケープ列を落とすための意図した制御文字
const ANSI = /\u001b\[[0-9;]*m/g;

function formatReport(o: ModelRunOptions, details: fc.RunDetails<unknown>, failingLog: readonly string[]): string {
  const commands = details.counterexample ? String((details.counterexample as unknown[])[0]) : '(none)';
  const replayPath = /replayPath="([^"]*)"/.exec(commands)?.[1];
  const error =
    details.errorInstance instanceof Error
      ? (details.errorInstance.stack ?? details.errorInstance.message)
      : String(details.errorInstance);
  const env = [
    `FC_SEED=${details.seed}`,
    `FC_PATH=${details.counterexamplePath ?? ''}`,
    ...(replayPath ? [`FC_REPLAY_PATH='${replayPath}'`] : []),
    `FC_STEPS=${o.steps}`,
    `FC_RUNS=${o.runs}`,
    ...(o.nightly ? ['NIGHTLY=1'] : []),
  ].join(' ');
  return [
    `### model-based E2E failure: ${o.testInfo.title}`,
    '',
    `- seed: \`${details.seed}\``,
    `- path: \`${details.counterexamplePath ?? ''}\``,
    `- shrinks: ${details.numShrinks}${details.interrupted ? ' (interrupted by the time limit: may not be minimal)' : ''}`,
    '',
    '縮約後の操作列 (実行された手だけ):',
    '',
    '```',
    commands,
    '```',
    '',
    '再実行:',
    '',
    '```sh',
    `${env} npm run test -w @typedcode/e2e -- tests/model/model-based.spec.ts -g '${o.grepToken}'`,
    '```',
    '',
    '<details><summary>エラー</summary>',
    '',
    '```',
    error.replace(ANSI, ''),
    '```',
    '',
    '</details>',
    '',
    '<details><summary>反例の列の操作ログ</summary>',
    '',
    '```',
    ...failingLog,
    '```',
    '',
    '</details>',
    '',
  ].join('\n');
}
