import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { expect, type Page } from '@playwright/test';
import JSZip from 'jszip';
import { BOOT_TIMEOUT_MS, CASUAL_SESSION_DB, EditorApp, NEUTRAL_PATH } from '../helpers/app.js';
import { runVerifyCliWithVerdicts } from '../helpers/verifyCli.js';
import {
  type EditorDriver,
  type EditorModel,
  type ModelLanguage,
  type ModelTab,
  type ModelTabSwitch,
  type ResumeTamper,
  activate,
  fullFilename,
  nextUntitledName,
} from './editorModel.js';

/**
 * キー操作。Playwright の `Desktop Chrome` は Windows の UA なので、Monaco はどの OS で動かしても
 * Windows のキー割り当て (全選択 Ctrl+A・文書の末尾 Ctrl+End) と改行 CRLF を使う。一方コピー・ペーストは
 * ブラウザ本来の操作なので、実際の OS の修飾キーで押す (mac: Cmd / それ以外: Ctrl。EditorApp と同じ)。
 * mac で Cmd+A を押すと Monaco は全選択せず、空の選択のまま Cmd+C が行ごとコピーになる。
 */
const CLIPBOARD_MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const SELECT_ALL = 'Control+A';
const DOC_END = 'Control+End';
/**
 * 同じタブを続けて押すときに空ける間。TabUIController は 300ms 以内の同じタブへの 2 回目の
 * クリックをダブルクリック (改名) と判定するので、それより長く空ける。
 */
const SAME_TAB_CLICK_GAP_MS = 350;

/**
 * C ランタイムの取得先 (CExecutor が clang の webc を取る外部配信)。editor は起動のたびに C ランタイムを
 * バックグラウンドで初期化するので、model の列はリロード・再開のたびにここへ取りに行く。到達できる日と
 * できない日で結果が変わらないよう、model では常に route で止める (`start()`。#771)。model の手に
 * コードを実行する手は無く、C の実物の実行は `@nightly` の code-execution-c-python.spec.ts /
 * production-build.spec.ts が外部配信で見る。
 */
const EXTERNAL_C_RUNTIME_ORIGIN = 'https://assets.typedcode.dev/';

const BLOCKED_C_RUNTIME = 'C ランタイムの取得先を route で止めた結果 (EXTERNAL_C_RUNTIME_ORIGIN。#771)';

/**
 * console.error のうち、既知のノイズとして許すもの。根拠を書けるものだけを足す (無闇に広げない)。
 * 判定は文言 (`msg.text()`) の 1 行目の完全一致と、`url` があれば発生元 (`msg.location().url`) の前方一致。
 * 1 行目だけを見るのは、console.error に Error を渡すと 2 行目以降にスタック (dev と build で行番号が変わる) が付くため。
 */
const ALLOWED_CONSOLE_ERRORS: readonly { text: string; url?: string; reason: string }[] = [
  { text: 'Failed to load resource: net::ERR_FAILED', url: EXTERNAL_C_RUNTIME_ORIGIN, reason: BLOCKED_C_RUNTIME },
  { text: '[CExecutor] Initialization failed: TypeError: Failed to fetch', reason: BLOCKED_C_RUNTIME },
  {
    text: '[RuntimeManager] C runtime initialization failed: Error: Failed to initialize C compiler: Failed to fetch',
    reason: BLOCKED_C_RUNTIME,
  },
];

function isAllowedConsoleError(text: string, url: string): boolean {
  const firstLine = text.split('\n', 1)[0];
  return ALLOWED_CONSOLE_ERRORS.some((a) => firstLine === a.text && (a.url === undefined || url.startsWith(a.url)));
}

/**
 * `EditorDriver` の Playwright 実装。操作は EditorApp (helpers/app.ts) を使い、Monaco のカーソル位置に
 * 依存する打鍵・ペーストだけはここで「末尾へ移ってから」行う (EditorApp.typeCode は `.view-lines` の
 * 中央を押すので、内容が長いと文書の途中に打ってしまい、モデルの予測とずれる)。
 * 状態の判定は状態契約 (data-*) と `__tcTestSnapshot`、証明の判定は verify-cli の結論だけを読む。
 * 1 本の列ごとに作り直す (runner.ts が列ごとに新しいブラウザコンテキストのページを渡す)。
 */
export class PlaywrightEditorDriver implements EditorDriver {
  /** 現在のページ。`closeAndResume` が閉じて開き直すたびに差し替わる (コンテキストは同じ) */
  page: Page;
  app: EditorApp;
  /** pageerror と許可リスト外の console.error (各手の後に 0 件であることを見る) */
  readonly errors: string[] = [];
  /** 直近の 1 本分の操作ログ (失敗の報告に添える) */
  readonly lines: string[] = [];
  private lastTabClick: { id: string; at: number } | null = null;
  private runLabel = '';

  constructor(page: Page) {
    this.page = page;
    this.app = new EditorApp(page);
    this.watchErrors(page);
  }

  /** pageerror と console.error の監視 (ページを開き直したら新しいページにも付ける。`errors` は引き継ぐ)。 */
  private watchErrors(page: Page): void {
    page.on('pageerror', (e) => this.errors.push(`pageerror: ${e.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !isAllowedConsoleError(msg.text(), msg.location().url)) {
        this.errors.push(`console.error: ${msg.text()} (${msg.location().url})`);
      }
    });
  }

  /** 1 本の列の始まり: クリーンな casual を開き、既定タブ 1 本の初期モデルを返す。 */
  async start(runLabel: string): Promise<EditorModel> {
    this.runLabel = runLabel;
    this.errors.length = 0;
    this.lines.length = 0;
    this.lastTabClick = null;
    this.log('start (openCasualFresh)');
    // 列ごとのコンテキストに張る (CloseAndResume で開き直すページも同じコンテキスト)。上の EXTERNAL_C_RUNTIME_ORIGIN
    await this.page.context().route(`${EXTERNAL_C_RUNTIME_ORIGIN}**`, (route) => route.abort());
    await this.app.openCasualFresh();
    const tabs = await this.app.tabs();
    expect(tabs, 'casual starts with exactly one tab').toHaveLength(1);
    const model: EditorModel = { tabs: [], activeId: null, pasteSeq: 0, switches: [] };
    model.tabs.push({
      id: tabs[0]!.id,
      name: nextUntitledName(model),
      language: 'c',
      content: '',
      externalPaste: false,
      maxEventCount: 0,
    });
    // 既定タブは active が無い状態から作られるので、切替の履歴の最初は null → 既定タブ
    activate(model, tabs[0]!.id);
    await this.expectMatches(model);
    return model;
  }

  log(line: string): void {
    this.lines.push(line);
    console.log(`[model ${this.runLabel}] ${line}`);
  }

  async addTab(knownIds: readonly string[], fromWelcome: boolean): Promise<string> {
    await this.page.locator(fromWelcome ? '#welcome-new-file' : '#add-tab-btn').click();
    let created: string | undefined;
    await expect
      .poll(
        async () => {
          const fresh = (await this.app.tabs()).filter((t) => !knownIds.includes(t.id));
          created = fresh.length === 1 && fresh[0]!.active ? fresh[0]!.id : undefined;
          return fresh.map((t) => ({ id: t.id, active: t.active }));
        },
        { timeout: 30_000, message: 'exactly one new tab appears and becomes active' }
      )
      .toEqual([{ id: expect.any(String), active: true }]);
    return created!;
  }

  async switchTab(tabId: string): Promise<void> {
    await this.waitSameTabClickGap(tabId);
    await this.app.switchToTab(tabId);
    this.lastTabClick = { id: tabId, at: Date.now() };
  }

  async renameTab(tabId: string, name: string): Promise<void> {
    await this.waitSameTabClickGap(tabId);
    await this.app.renameTab(tabId, name);
    // ダブルクリックと判定された時点でアプリ側の直前クリックの記録は消える。
    this.lastTabClick = null;
  }

  async closeTab(tabId: string, answer: 'confirm' | 'cancel'): Promise<void> {
    await this.app.requestCloseTab(tabId);
    await this.app.answerCloseTab(answer);
  }

  async type(text: string): Promise<void> {
    await this.focusAtEnd();
    const lines = text.split('\n');
    for (const [i, line] of lines.entries()) {
      if (line) await this.page.keyboard.type(line, { delay: 12 });
      if (i < lines.length - 1) {
        // 補完の候補が出ていると Enter で確定してしまうので、閉じてから改行する。
        await this.page.keyboard.press('Escape');
        await this.page.keyboard.press('Enter');
      }
    }
  }

  async pasteExternal(text: string): Promise<void> {
    await this.page.evaluate((t) => navigator.clipboard.writeText(t), text);
    await this.focusAtEnd();
    await this.page.keyboard.press(`${CLIPBOARD_MOD}+V`);
  }

  async internalCopyPaste(): Promise<void> {
    await this.focusAtEnd();
    await this.page.keyboard.press(SELECT_ALL);
    await this.page.keyboard.press(`${CLIPBOARD_MOD}+C`);
    await this.page.keyboard.press(DOC_END);
    await this.page.keyboard.press('End');
    await this.page.keyboard.press('Enter');
    await this.page.keyboard.press(`${CLIPBOARD_MOD}+V`);
  }

  async setLanguage(language: ModelLanguage): Promise<void> {
    await this.app.setLanguage(language);
  }

  async reload(hadNoTabs: boolean): Promise<string | null> {
    await this.app.reloadAndResume();
    this.lastTabClick = null;
    if (!hadNoTabs) return null;
    const tabs = await this.app.tabs();
    expect(tabs, 'casual opens one default tab when restored with no tabs').toHaveLength(1);
    return tabs[0]!.id;
  }

  /**
   * 同期を待ってからブラウザのタブを閉じ (sessionStorage は消え、IndexedDB は残る)、同じコンテキストで
   * 開き直して (`?reset` 無し) 復旧ダイアログの「再開」を押す。手順は close-tab-recovery.spec.ts と同じ。
   * 復旧ダイアログが出ることが前提 (出なければ IndexedDB の復旧経路を通っていないので落とす)。
   * `tamper` があれば、閉じた後・開き直す前に保存データへ入れる (`ResumeTamper`。#616)。
   */
  async closeAndResume(tamper: ResumeTamper): Promise<void> {
    await this.app.waitForSynced();
    const context = this.page.context();
    await this.page.close();
    if (tamper !== 'none') {
      // 書き換えは閉じた後に、session DB を開かないページから行う (閉じる前だと、閉じる時の visibility の
      // append が値を進めてしまう。close-tab-recovery.spec.ts の #322 と同じ)
      const neutral = await context.newPage();
      await neutral.goto(NEUTRAL_PATH);
      const changed = await tamperStoredSession(neutral, tamper);
      await neutral.close();
      this.log(`  ${tamper}: ${changed}`);
    }
    const page = await context.newPage();
    this.page = page;
    this.app = new EditorApp(page);
    this.watchErrors(page);
    this.lastTabClick = null;
    await page.goto('/casual');
    const resume = page.locator('#session-resume-btn');
    await resume.waitFor({ state: 'visible', timeout: 30_000 });
    await resume.click();
    await page.locator('.monaco-editor .view-lines').first().waitFor({ state: 'visible', timeout: BOOT_TIMEOUT_MS });
    await expect.poll(() => this.app.eventCount(), { timeout: 30_000 }).toBeGreaterThan(0);
  }

  async expectStoredStateMatches(model: Readonly<EditorModel>): Promise<void> {
    const expected = model.tabs
      .map((t) => ({ id: t.id, content: t.content, tailIsCurrentHash: true, chainLinked: true }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    await expect
      .poll(
        async () =>
          (await readStoredSession(this.page)).map((t) => ({
            id: t.id,
            content: toLf(t.content),
            tailIsCurrentHash: t.events.length > 0 && t.events.at(-1)!.hash === t.currentHash,
            chainLinked: t.events.every(
              (e, i) => e.index === i && (i === 0 || e.previousHash === t.events[i - 1]!.hash)
            ),
          })),
        {
          timeout: 30_000,
          message:
            'stored tabs (id / content) match the model, each stored chain is linked and ends at the stored currentHash',
        }
      )
      .toEqual(expected);
  }

  async focusLossAndReturn(): Promise<void> {
    await this.app.simulateFocusLossAndReturn();
  }

  /**
   * 手としての export (`ExportAllTabs`): 同期を待たずに全タブを export し、書き出しの時点のモデルの全タブと
   * 突き合わせる (PoSW の処理待ちが残っていれば、export の排出待ちの経路も通る)。
   */
  async exportAllTabs(model: Readonly<EditorModel>): Promise<void> {
    const zipPath = await this.app.exportAllTabs();
    await expectProofsMatch(zipPath, model);
  }

  /** 列の最後: 同期を待ってから全タブを export し、モデルの全タブと突き合わせる。 */
  async exportAllTabsAfterSync(model: Readonly<EditorModel>): Promise<void> {
    await this.app.waitForSynced();
    await this.exportAllTabs(model);
  }

  async expectMatches(model: EditorModel): Promise<void> {
    // 1. DOM の状態契約と内部状態が一致する (アクティブなタブの PoSW が掃けるまで待つ)。
    await this.app.expectConsistent();
    // 2. DOM のタブ列 (順序・id・filename・language) と active がモデルと一致する。
    const expectedTabs = model.tabs.map((t) => ({
      id: t.id,
      filename: fullFilename(t),
      language: t.language,
      active: t.id === model.activeId,
    }));
    await expect
      .poll(
        async () =>
          (await this.app.tabs()).map(({ id, filename, language, active }) => ({ id, filename, language, active })),
        { timeout: 15_000, message: 'DOM tabs (order / id / filename / language / active) match the model' }
      )
      .toEqual(expectedTabs);
    // 各タブの内容がモデルの予測どおり (打鍵・ペーストの結果がずれていない)。
    const snap = await this.app.snapshot();
    expect(snap.activeTabId, 'snapshot activeTabId matches the model').toBe(model.activeId);
    expect(
      snap.tabs.map((t) => ({ id: t.id, content: toLf(t.content) })),
      'tab contents match the model'
    ).toEqual(model.tabs.map((t) => ({ id: t.id, content: t.content })));
    // 開いているダイアログ: タブ 0 本ならウェルカム画面だけ、それ以外は何も開いていない。
    await expect
      .poll(() => this.app.openDialogs(), { message: 'open dialogs match the model' })
      .toEqual(model.tabs.length === 0 ? ['welcome'] : []);
    // 3. 件数 (アクティブなタブの #event-count) はタブごとに減らない。
    const active = model.tabs.find((t) => t.id === model.activeId);
    if (active) {
      const count = await this.app.eventCount();
      expect(count, `event count of tab ${active.id} must not decrease`).toBeGreaterThanOrEqual(active.maxEventCount);
      active.maxEventCount = count;
    }
    // 4. pageerror と console.error が出ていない。
    expect(this.errors, 'no pageerror / console.error so far').toEqual([]);
  }

  /** 末尾にカーソルを置く (補完の候補が出ていれば閉じる)。 */
  private async focusAtEnd(): Promise<void> {
    await this.app.focusEditor();
    await this.page.keyboard.press('Escape');
    await this.page.keyboard.press(DOC_END);
  }

  private async waitSameTabClickGap(tabId: string): Promise<void> {
    if (this.lastTabClick?.id !== tabId) return;
    const wait = this.lastTabClick.at + SAME_TAB_CLICK_GAP_MS - Date.now();
    if (wait > 0) await this.page.waitForTimeout(wait);
  }
}

/** 実アプリの内容を LF に揃える (Monaco の改行は CRLF。上の「キー操作」を参照。モデルは LF で持つ)。 */
function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** ZIP 内の proof (エントリの並び = export したタブの順)。 */
interface ExportedProof {
  entry: string;
  filename: string;
  language: string;
  content: string;
}

async function readProofs(zipPath: string): Promise<ExportedProof[]> {
  const zip = await JSZip.loadAsync(await readFile(zipPath));
  const entries = Object.keys(zip.files).filter((n) => n.endsWith('_proof.json') || /_proof_\d+\.json$/.test(n));
  return Promise.all(
    entries.map(async (entry) => {
      const proof = JSON.parse(await zip.files[entry]!.async('string')) as Omit<ExportedProof, 'entry'>;
      return { entry, filename: proof.filename, language: proof.language, content: proof.content };
    })
  );
}

/**
 * export した ZIP を verify-cli (--mode fast) で検証し、全 proof が pass すること、proof の最終内容・
 * 名前・言語がモデルと一致すること、Pure Typing が「外部ペーストをしたタブだけ false」であることを確かめる。
 * proof とタブの対応は並び順 (export はタブの表示順に proof を足す。名前は重なりうるので名前では引かない)。
 */
async function expectProofsMatch(zipPath: string, model: Readonly<EditorModel>): Promise<void> {
  const tabs: readonly Readonly<ModelTab>[] = model.tabs;
  const cli = runVerifyCliWithVerdicts(zipPath, ['--mode', 'fast']);
  const output = cli.stdout + cli.stderr;
  expect(cli.exitCode, `verify-cli --mode fast passes every proof\n${output}`).toBe(0);
  const proofs = await readProofs(zipPath);
  expect(
    proofs.map(({ filename, language, content }) => ({ filename, language, content: toLf(content) })),
    'exported proofs (in tab order) carry the model name / language / content'
  ).toEqual(tabs.map((t) => ({ filename: t.name, language: t.language, content: t.content })));
  expect(cli.verdicts, output).toHaveLength(tabs.length);
  for (const [i, proof] of proofs.entries()) {
    const verdict = cli.verdicts.find((v) => basename(v.filename) === basename(proof.entry));
    expect(verdict?.valid, `${proof.entry} is valid\n${output}`).toBe(true);
    expect(
      verdict?.assurance.provenance.pureTyping,
      `pure typing of ${proof.entry} is false only when the tab had an external paste`
    ).toBe(!tabs[i]!.externalPaste);
  }
  // タブ切替の履歴: 追記順 (= モデルの手の順) に並ぶ (#401。閉じて再開をまたいでも)。timestamp の値は見ない。
  // 履歴が空なら export は tab-switches.json を入れない
  expect(await readTabSwitches(zipPath), 'tab-switches.json lists the tab switches in the order they happened').toEqual(
    model.switches
  );
}

async function readTabSwitches(zipPath: string): Promise<ModelTabSwitch[]> {
  const zip = await JSZip.loadAsync(await readFile(zipPath));
  const entry = zip.file('tab-switches.json');
  if (!entry) return [];
  const switches = JSON.parse(await entry.async('string')) as { fromTabId: string | null; toTabId: string }[];
  return switches.map((s) => ({ from: s.fromTabId, to: s.toTabId }));
}

/** 保存された 1 タブ分 (tabs レコードと、そのタブの events を eventIndex 順に) */
interface StoredTabState {
  id: string;
  content: string;
  currentHash: string;
  events: { index: number; hash: string; previousHash: string | null }[];
}

/**
 * casual の session DB から全タブのレコードと events を読む (読み取りだけ。開いているエディタのページから呼ぶ)。
 * currentHash は editor の `getTab` / `loadTabs` と同じく、tabs 行と tabProgress (#627) の位置の大きい方
 * (同じなら tabProgress) から採る。
 */
function readStoredSession(page: Page): Promise<StoredTabState[]> {
  return page.evaluate(
    (dbName) =>
      new Promise<StoredTabState[]>((resolve, reject) => {
        const open = indexedDB.open(dbName);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['tabs', 'tabProgress', 'events'], 'readonly');
          const tabsReq = tx.objectStore('tabs').getAll();
          const progressReq = tx.objectStore('tabProgress').getAll();
          const eventsReq = tx.objectStore('events').getAll();
          tx.onerror = () => reject(tx.error);
          tx.oncomplete = () => {
            db.close();
            type Row = { tabId: string; eventIndex: number; eventData: { hash: string; previousHash: string | null } };
            type Position = { lastWrittenEventIndex: number; currentHash: string };
            const events = (eventsReq.result as Row[]).sort((a, b) => a.eventIndex - b.eventIndex);
            const progress = new Map(
              (progressReq.result as (Position & { tabId: string })[]).map((p) => [p.tabId, p] as const)
            );
            resolve(
              (tabsReq.result as (Position & { id: string; content: string })[])
                .map((t) => {
                  const p = progress.get(t.id);
                  return {
                    ...t,
                    currentHash:
                      p && p.lastWrittenEventIndex >= t.lastWrittenEventIndex ? p.currentHash : t.currentHash,
                  };
                })
                .map((t) => ({
                  id: t.id,
                  content: t.content,
                  currentHash: t.currentHash,
                  events: events
                    .filter((e) => e.tabId === t.id)
                    .map((e) => ({
                      index: e.eventIndex,
                      hash: e.eventData.hash,
                      previousHash: e.eventData.previousHash,
                    })),
                }))
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            );
          };
        };
      }),
    CASUAL_SESSION_DB
  );
}

/**
 * 閉じたセッションの保存データに手を入れる (`ResumeTamper`。#616)。`page` は session DB を開かないページ。
 * 手を入れたもの (ログ用) を返す。前提が崩れていたら (戻すイベントが無い・session が無い) throw する
 * (手が空振りすると観測していないのに通ってしまうため)。
 */
function tamperStoredSession(page: Page, tamper: Exclude<ResumeTamper, 'none'>): Promise<string> {
  return page.evaluate(
    ({ dbName, tamper }) =>
      new Promise<string>((resolve, reject) => {
        const open = indexedDB.open(dbName);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['sessions', 'tabs', 'tabProgress', 'events'], 'readwrite');
          let summary = '';
          let failure: Error | null = null;
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(failure ?? tx.error);
          tx.oncomplete = () => {
            db.close();
            resolve(summary);
          };
          const fail = (message: string) => {
            failure = new Error(message);
            tx.abort();
          };
          if (tamper === 'emptyTabOrder') {
            const req = tx.objectStore('sessions').getAll();
            req.onsuccess = () => {
              const sessions = req.result as { tabOrder: string[] }[];
              if (sessions.length === 0) return fail('emptyTabOrder: no stored session');
              for (const s of sessions) {
                summary += `tabOrder ${s.tabOrder.length} -> 0; `;
                s.tabOrder = [];
                tx.objectStore('sessions').put(s);
              }
            };
            return;
          }
          // staleHash: 各タブの currentHash を、events の 1 つ前の hash に戻す (#322 の手本は先頭の hash)。
          // append の位置は tabProgress にもあり、読み出しは同じ位置なら tabProgress を採るので両方戻す (#627)
          const tabsReq = tx.objectStore('tabs').getAll();
          const progressReq = tx.objectStore('tabProgress').getAll();
          const eventsReq = tx.objectStore('events').getAll();
          let pending = 3;
          const done = () => {
            if (--pending > 0) return;
            type Row = { tabId: string; eventIndex: number; eventData: { hash: string } };
            const events = (eventsReq.result as Row[]).sort((a, b) => a.eventIndex - b.eventIndex);
            const progressRows = progressReq.result as { tabId: string; currentHash: string }[];
            let rewound = 0;
            for (const tab of tabsReq.result as { id: string; currentHash: string }[]) {
              const own = events.filter((e) => e.tabId === tab.id);
              const tail = own.at(-1)?.eventData.hash;
              const previous = own.at(-2)?.eventData.hash;
              if (!previous || !tail) continue;
              tab.currentHash = previous;
              tx.objectStore('tabs').put(tab);
              for (const progress of progressRows.filter((p) => p.tabId === tab.id)) {
                progress.currentHash = previous;
                tx.objectStore('tabProgress').put(progress);
              }
              rewound += 1;
            }
            if (rewound === 0) return fail('staleHash: no stored tab had 2+ events to rewind to');
            summary = `rewound currentHash of ${rewound}/${tabsReq.result.length} tabs`;
          };
          tabsReq.onsuccess = done;
          progressReq.onsuccess = done;
          eventsReq.onsuccess = done;
        };
      }),
    { dbName: CASUAL_SESSION_DB, tamper }
  );
}
