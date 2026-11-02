import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { expect, type Page } from '@playwright/test';
import JSZip from 'jszip';
import { EditorApp } from '../helpers/app.js';
import { runVerifyCliWithVerdicts } from '../helpers/verifyCli.js';
import {
  type EditorDriver,
  type EditorModel,
  type ModelLanguage,
  type ModelTab,
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
 * console.error のうち、既知のノイズとして許すもの。根拠を書けるものだけを足す (無闇に広げない)。
 * 判定は部分一致。
 */
const ALLOWED_CONSOLE_ERRORS: readonly { pattern: string; reason: string }[] = [];

function isAllowedConsoleError(text: string): boolean {
  return ALLOWED_CONSOLE_ERRORS.some((a) => text.includes(a.pattern));
}

/**
 * `EditorDriver` の Playwright 実装。操作は EditorApp (helpers/app.ts) を使い、Monaco のカーソル位置に
 * 依存する打鍵・ペーストだけはここで「末尾へ移ってから」行う (EditorApp.typeCode は `.view-lines` の
 * 中央を押すので、内容が長いと文書の途中に打ってしまい、モデルの予測とずれる)。
 * 状態の判定は状態契約 (data-*) と `__tcTestSnapshot`、証明の判定は verify-cli の結論だけを読む。
 * 1 本の列ごとに作り直す (runner.ts が列ごとに新しいブラウザコンテキストのページを渡す)。
 */
export class PlaywrightEditorDriver implements EditorDriver {
  readonly app: EditorApp;
  /** pageerror と許可リスト外の console.error (各手の後に 0 件であることを見る) */
  readonly errors: string[] = [];
  /** 直近の 1 本分の操作ログ (失敗の報告に添える) */
  readonly lines: string[] = [];
  private lastTabClick: { id: string; at: number } | null = null;
  private runLabel = '';
  /** 記録された contentSnapshot のイベント index (editor の console.log から拾う。下の settleSnapshotLag) */
  private readonly contentSnapshotIndexes = new Set<number>();

  constructor(readonly page: Page) {
    this.app = new EditorApp(page);
    page.on('pageerror', (e) => this.errors.push(`pageerror: ${e.message}`));
    page.on('console', (msg) => {
      const snapshotAt = /Content snapshot recorded at event (\d+)/.exec(msg.text());
      if (snapshotAt) this.contentSnapshotIndexes.add(Number(snapshotAt[1]));
      if (msg.type() === 'error' && !isAllowedConsoleError(msg.text())) {
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
    await this.app.openCasualFresh();
    const tabs = await this.app.tabs();
    expect(tabs, 'casual starts with exactly one tab').toHaveLength(1);
    const model: EditorModel = { tabs: [], activeId: null, pasteSeq: 0 };
    model.tabs.push({
      id: tabs[0]!.id,
      name: nextUntitledName(model),
      language: 'c',
      content: '',
      externalPaste: false,
      maxEventCount: 0,
    });
    model.activeId = tabs[0]!.id;
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

  async focusLossAndReturn(): Promise<void> {
    await this.app.simulateFocusLossAndReturn();
  }

  async exportCurrentTab(tab: Readonly<ModelTab>): Promise<void> {
    const zipPath = await this.app.exportCurrentTab();
    await expectProofsMatch(zipPath, [tab]);
  }

  /** 全タブを export し、verify-cli の判定と proof の中身をモデルの全タブと突き合わせる (列の最後)。 */
  async exportAllTabs(model: Readonly<EditorModel>): Promise<void> {
    await this.app.waitForSynced();
    const zipPath = await this.app.exportAllTabs();
    await expectProofsMatch(zipPath, model.tabs);
  }

  async expectMatches(model: EditorModel): Promise<void> {
    // 1. DOM の状態契約と内部状態が一致する (アクティブなタブの PoSW が掃けるまで待つ)。
    await this.settleSnapshotLag();
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

  /**
   * 既知の不具合の回避: contentSnapshot (`ProofStatusDisplay.checkSnapshot` が 100 イベントごとに記録) は
   * proof に載るのに `#event-count` / `#current-hash` の表示を更新しないので、それが手の最後のイベントだと
   * 表示が遅れたまま止まり、`expectConsistent()` が落ちる (次のイベントで追いつく)。contentSnapshot が
   * 2 件続けて記録されることもあり、そのときは 2 件遅れる。
   * 「アクティブなタブの pending が 0・表示が k 件少ない・足りない k 件がどれも contentSnapshot」のときだけ、
   * 内容を変えない打鍵 (Shift) を 1 回足して表示を追いつかせる。それ以外の食い違いはそのまま
   * `expectConsistent()` に落とさせる。直ったらこのメソッドを消す。
   */
  private async settleSnapshotLag(): Promise<void> {
    const read = async () => {
      const snap = await this.app.snapshot();
      return { tab: snap.tabs.find((t) => t.id === snap.activeTabId), dom: await this.app.eventCount() };
    };
    if (!(await read()).tab) return;
    await expect.poll(async () => (await read()).tab?.pendingCount ?? 0, { timeout: 30_000 }).toBe(0);
    const { tab, dom } = await read();
    if (!tab || dom >= tab.totalEvents) return;
    for (let i = dom; i < tab.totalEvents; i++) {
      if (!this.contentSnapshotIndexes.has(i)) return;
    }
    this.log(
      `  known lag: #event-count misses contentSnapshot at events ${dom}..${tab.totalEvents - 1}; pressing Shift`
    );
    await this.app.focusEditor();
    await this.page.keyboard.press('Shift');
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
async function expectProofsMatch(zipPath: string, tabs: readonly Readonly<ModelTab>[]): Promise<void> {
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
}
