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
