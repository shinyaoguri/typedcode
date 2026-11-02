import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * 検証 Web (`packages/verify`) を Playwright から駆動するページオブジェクト。
 *
 * 判定は **data-* の状態契約だけ** を読む (verify/AGENTS.md「状態契約」、ADR-0034)。
 * 翻訳テキスト・色クラス・見た目には依存しない。契約の表と値域を変えるときはこのファイルも
 * 同じ PR で直すこと。
 */

/** `.file-item` / `.tab` の `data-status` (VerificationController が決めた値)。 */
export type VerifyFileStatus = 'pending' | 'verifying' | 'success' | 'warning' | 'error';

/** 検証モード (`?mode=`)。e2e の既定は fast (PoSW full は happy-path の 1 本だけ = 不変条件 4)。 */
export type VerifyMode = 'fast' | 'audit' | 'full';

export interface VerifyFileState {
  /** `data-filename` (表示名。ZIP 内のファイルはベース名)。 */
  filename: string;
  status: VerifyFileStatus;
}

/**
 * 1 ファイルを選択した状態で読んだ判定。属性が付いていない (= 判定を表示していない) ものは null。
 * 検証自体が失敗したファイル (status `error`・結果なし) では assurance / level が null になりうる。
 */
export interface VerifyVerdict extends VerifyFileState {
  /** `#assurance-strip[data-integrity]`: proven / partial / failed */
  integrity: string | null;
  /** `#assurance-strip[data-temporal]`: anchored / partial / unanchored / exam-t0 */
  temporal: string | null;
  /** `#assurance-strip[data-pure-typing]`: 'true' / 'false' (advisory) */
  pureTyping: string | null;
  /** `#result-status-icon[data-level]`: verified / partial / failed (TrustCalculator) */
  level: string | null;
  /** `#tabbar .tab[data-filename]` の `data-status` (サイドバーと同じ値のはず)。タブが無ければ null。 */
  tabStatus: VerifyFileStatus | null;
}

/**
 * ステータスバーの検証集約 (`#queue-status[data-proof-*]`, #282)。警告は passed に数える
 * (verify-cli の summary の `valid` と同じ軸)。判定が無い間 (検証中・proof 0 件) は属性が無いので null。
 */
export interface VerifyProofSummary {
  total: number;
  passed: number;
  failed: number;
}

/** 結果パネルのチャートタブ (`#tab-<name>` / `#panel-<name>`)。 */
export type ChartTabName = 'integrated' | 'timeline' | 'mouse';

const UNSETTLED: ReadonlySet<string> = new Set(['pending', 'verifying']);

/**
 * 既定の verify Web の URL。dev 設定 (playwright.config.ts) が `E2E_VERIFY_URL` を置く。
 * 本番ビルド設定では editor の配下 (`/verify/`) にあるので、呼び出し側が明示的に渡す。
 */
export function defaultVerifyUrl(): string {
  const url = process.env.E2E_VERIFY_URL;
  if (!url) throw new Error('E2E_VERIFY_URL is not set (playwright.config.ts sets it for the dev config)');
  return url;
}

export class VerifyWebApp {
  /**
   * @param page    Playwright の Page (editor と同じ page を使い回してよい)
   * @param baseUrl verify Web のルート (末尾 `/`)。既定は dev の verify サーバ
   */
  constructor(
    public readonly page: Page,
    private readonly baseUrl: string = defaultVerifyUrl()
  ) {}

  /** verify Web を開く。`mode` は `?mode=` (初期の検証モード) に入る。 */
  async open(mode: VerifyMode = 'fast'): Promise<void> {
    const url = new URL(this.baseUrl);
    url.searchParams.set('mode', mode);
    await this.page.goto(url.toString());
    await this.page.locator('#file-input').waitFor({ state: 'attached' });
  }

  /**
   * ファイル (ZIP / proof JSON) を `#file-input` (multiple) に一度に渡し、全ファイルの検証が
   * 終わるまで待つ。サイドバーの全 `.file-item` の状態を返す。
   */
  async load(paths: string[]): Promise<VerifyFileState[]> {
    await this.page.locator('#file-input').setInputFiles(paths);
    return this.waitSettled(paths.length);
  }

  /**
   * サイドバーの全 `.file-item` の `data-status` が pending / verifying でなくなるまで待つ。
   * ZIP は展開後にまとめて行が増え、複数ファイルは 1 件ずつ処理されるので、「行が `minItems` 件
   * 以上ある」かつ「確定状態が 2 回続けて同じ」を完了とみなす (途中で 1 件目だけ確定した瞬間を
   * 完了と誤認しないため)。
   */
  async waitSettled(minItems = 1, timeout = 120_000): Promise<VerifyFileState[]> {
    let prev = '';
    let settled: VerifyFileState[] = [];
    await expect
      .poll(
        async () => {
          const states = await this.fileStates();
          const done = states.length >= minItems && states.every((s) => !UNSETTLED.has(s.status));
          const key = JSON.stringify(states);
          const stable = done && key === prev;
          prev = done ? key : '';
          settled = states;
          return stable;
        },
        { timeout, intervals: [250, 500] }
      )
      .toBe(true);
    return settled;
  }

  /** サイドバーの全 `.file-item` (表示順)。 */
  async fileStates(): Promise<VerifyFileState[]> {
    return this.page.locator('#file-list .file-item').evaluateAll((items) =>
      items.map((el) => ({
        filename: (el as HTMLElement).dataset.filename ?? '',
        status: ((el as HTMLElement).dataset.status ?? '') as VerifyFileStatus,
      }))
    );
  }

  /**
   * サイドバーで `filename` の行を選び、そのファイルの判定を読む。
   *
   * 属性は描画で同期的に付け外しされる (TabController.showTabContent)。判定のあるファイルは
   * 属性が現れるまで待ち、`error` のファイルは結果が無ければ属性が外れたまま (= null) を返す。
   * 表示名が重複していると別の行を読むおそれがあるので、1 行に定まらなければ throw する。
   */
  async readVerdict(filename: string): Promise<VerifyVerdict> {
    const item = this.page.locator(`#file-list .file-item[data-filename="${cssEscape(filename)}"]`);
    const count = await item.count();
    if (count !== 1) throw new Error(`expected exactly one .file-item for ${filename}, found ${count}`);
    const status = (await item.getAttribute('data-status')) as VerifyFileStatus;
    if (UNSETTLED.has(status)) throw new Error(`${filename} is still ${status}; call waitSettled() first`);

    await item.click();
    const tab = this.page.locator(`#tabbar .tab[data-filename="${cssEscape(filename)}"]`);
    await expect(tab).toHaveCount(1);

    if (status !== 'error') {
      // 判定を出したファイル。属性が現れるのを待つ (現れなければ契約違反として落ちる)。
      await expect(this.page.locator('#assurance-strip')).toHaveAttribute('data-integrity', /.+/);
      await expect(this.page.locator('#result-status-icon')).toHaveAttribute('data-level', /.+/);
    }

    const strip = this.page.locator('#assurance-strip');
    return {
      filename,
      status,
      integrity: await strip.getAttribute('data-integrity'),
      temporal: await strip.getAttribute('data-temporal'),
      pureTyping: await strip.getAttribute('data-pure-typing'),
      level: await this.page.locator('#result-status-icon').getAttribute('data-level'),
      tabStatus: (await tab.getAttribute('data-status')) as VerifyFileStatus | null,
    };
  }

  /**
   * `#queue-status` の `data-proof-total/passed/failed`。3 つとも付いていなければ null (= 集約を出していない)。
   * ステータスバーの更新は検証完了の次のタスク (setTimeout 0) で走るので、`waitSettled()` の直後は
   * `expect.poll(() => web.proofSummary())` で読む。
   */
  async proofSummary(): Promise<VerifyProofSummary | null> {
    const status = this.page.locator('#queue-status');
    const [total, passed, failed] = await Promise.all(
      ['total', 'passed', 'failed'].map((k) => status.getAttribute(`data-proof-${k}`))
    );
    if (total === null || passed === null || failed === null) return null;
    return { total: Number(total), passed: Number(passed), failed: Number(failed) };
  }

  /** ステータスバーの集約 (失敗を含むときだけ押せる) を押す。失敗した proof のタブが開く。 */
  async clickProofSummary(): Promise<void> {
    await this.page.locator('#queue-status').click({ timeout: 10_000 });
  }

  /** サイドバーで `filename` の行を選ぶ (対応するタブが開く)。 */
  async selectFile(filename: string): Promise<void> {
    const item = this.page.locator(`#file-list .file-item[data-filename="${cssEscape(filename)}"]`);
    await expect(item).toHaveCount(1);
    await item.click();
    await expect(this.page.locator(`#tabbar .tab[data-filename="${cssEscape(filename)}"]`)).toHaveCount(1);
  }

  /** `filename` のタブの閉じるボタンを押す (ファイルはサイドバーに残る)。 */
  async closeTab(filename: string): Promise<void> {
    await this.page.locator(`#tabbar .tab[data-filename="${cssEscape(filename)}"] .tab-close`).click();
  }

  /** `#tabbar .tab[data-active="true"]` の表示名。アクティブなタブが無ければ null。 */
  async activeTabFilename(): Promise<string | null> {
    return this.singleFilename('#tabbar .tab[data-active="true"]');
  }

  /** `#file-list .file-item[data-active="true"]` の表示名。アクティブな行が無ければ null。 */
  async activeFileItemFilename(): Promise<string | null> {
    return this.singleFilename('#file-list .file-item[data-active="true"]');
  }

  /** `#result-status-card[data-filename]`: 結果パネルが判定を出しているファイルの表示名。無ければ null。 */
  async displayedFilename(): Promise<string | null> {
    return this.page.locator('#result-status-card').getAttribute('data-filename');
  }

  /**
   * 結果パネルのチャートタブ (`#tab-<name>`) を **force なしで** 押す。人の操作と同じく、別の要素に
   * 覆われていれば Playwright が押せずに落ちる (#395)。押した結果は `activeChartTab()` で読む。
   */
  async clickChartTab(name: ChartTabName): Promise<void> {
    await this.page.locator(`#tab-${name}`).click({ timeout: 10_000 });
  }

  /** `.chart-tab[data-active="true"]` の `data-tab`。選択中のタブが 1 つに定まらなければ null。 */
  async activeChartTab(): Promise<string | null> {
    const loc = this.page.locator('#chart-section .chart-tab[data-active="true"]');
    return (await loc.count()) === 1 ? loc.getAttribute('data-tab') : null;
  }

  /** `.chart-panel[data-active="true"]` の id から `panel-` を除いたもの。表示中のパネルが 1 つに定まらなければ null。 */
  async activeChartPanel(): Promise<string | null> {
    const loc = this.page.locator('#chart-section .chart-panel[data-active="true"]');
    if ((await loc.count()) !== 1) return null;
    return (await loc.getAttribute('id'))?.replace(/^panel-/, '') ?? null;
  }

  /** セレクタに一致する要素がちょうど 1 つならその `data-filename`、0 個なら null。2 個以上は契約違反。 */
  private async singleFilename(selector: string): Promise<string | null> {
    const loc = this.page.locator(selector);
    const count = await loc.count();
    if (count > 1) throw new Error(`expected at most one ${selector}, found ${count}`);
    return count === 0 ? null : loc.getAttribute('data-filename');
  }

  /** `filenames` を順に選んで判定を読む (選び直すたびに描画し直されることも同時に見る)。 */
  async readVerdicts(filenames: string[]): Promise<VerifyVerdict[]> {
    const out: VerifyVerdict[] = [];
    for (const f of filenames) out.push(await this.readVerdict(f));
    return out;
  }
}

/** 属性セレクタの値に入れる文字列のエスケープ (ファイル名の `"` と `\` だけ気にすればよい)。 */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
