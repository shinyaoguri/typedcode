import fc from 'fast-check';

/**
 * model-based E2E (#436) のモデルとコマンド。
 *
 * モデルは「利用者から見えるエディタの状態」の仕様で、実アプリの実装を読まずに次の状態を決める
 * (タブ列・active・各タブの内容・言語・ファイル名・外部ペーストの有無・観測した件数の最大値)。
 * 実アプリへの操作と観測は `EditorDriver` に閉じる (Playwright の実装は playwrightDriver.ts)。
 * コマンドは「ドライバで操作 → モデルを進める → ドライバでモデルと実アプリを突き合わせる」を 1 手とする。
 *
 * 打鍵・ペーストの文字種は、Monaco の自動閉じ括弧・自動インデント・補完で内容の予測がずれないものに絞る
 * (英小文字・数字・空白・`=`・`;`・改行。行頭空白と `:` (python の自動インデント) を出さない)。
 */

/** モデルで扱う言語。補完 worker を持つ javascript / typescript は、候補の確定で内容がずれうるので入れない。 */
export const MODEL_LANGUAGES = ['c', 'cpp', 'python', 'plaintext'] as const;
export type ModelLanguage = (typeof MODEL_LANGUAGES)[number];

/** 言語 → 拡張子 (editor の `config/SupportedLanguages.ts` と同じ対応。`data-filename` は `name.ext`)。 */
const EXTENSIONS: Record<ModelLanguage, string> = { c: 'c', cpp: 'cpp', python: 'py', plaintext: 'txt' };

/** タブは多くても 4 本 (export・切替の組合せを見るのに足り、1 手あたりの時間を抑える)。 */
export const MAX_TABS = 4;

/** 内部コピペは内容を倍にするので、元が短いときだけ行う (打鍵時間と PoSW の量を抑える)。 */
export const MAX_COPY_SOURCE_LENGTH = 200;

export interface ModelTab {
  /** 実アプリのタブ id (作成時に実アプリから採る。UUID なのでモデルからは決められない) */
  id: string;
  /** 拡張子を除いた名前 */
  name: string;
  language: ModelLanguage;
  content: string;
  /** このタブで外部ペーストをしたか (Pure Typing の期待値 = !externalPaste) */
  externalPaste: boolean;
  /** このタブがアクティブなときに観測した `#event-count[data-count]` の最大値 (減らないことを見る) */
  maxEventCount: number;
}

export interface EditorModel {
  tabs: ModelTab[];
  activeId: string | null;
  /** 外部ペーストの通し番号 (ペーストする文字列を 1 本の列の中で一意にする) */
  pasteSeq: number;
}

/** 拡張子込みの名前 (状態契約の `data-filename` と同じ表現)。 */
export function fullFilename(tab: Pick<ModelTab, 'name' | 'language'>): string {
  return `${tab.name}.${EXTENSIONS[tab.language]}`;
}

/** 新しいタブの名前 (`Untitled-N`)。今あるタブの `Untitled-N` の最大 + 1、無ければ 1。 */
export function nextUntitledName(model: Readonly<EditorModel>): string {
  const nums = model.tabs.map((t) => /^Untitled-(\d+)$/i.exec(t.name)).flatMap((m) => (m ? [Number(m[1])] : []));
  return `Untitled-${nums.length === 0 ? 1 : Math.max(...nums) + 1}`;
}

export function activeTab(model: Readonly<EditorModel>): ModelTab | undefined {
  return model.tabs.find((t) => t.id === model.activeId);
}

/** 新しいタブのモデル (作成直後: c・空・アクティブ)。 */
function newTab(id: string, name: string): ModelTab {
  return { id, name, language: 'c', content: '', externalPaste: false, maxEventCount: 0 };
}

/**
 * 実アプリへの操作と観測。コマンドは対象をモデルで決めてから、ここを呼ぶ。
 * 戻り値で実アプリから採るのは、モデルで決められない新しいタブの id だけ。
 */
export interface EditorDriver {
  log(line: string): void;
  /** タブを足す (タブ 0 本ならウェルカム画面の「新規ファイル」)。新しいタブの id を返す。 */
  addTab(knownIds: readonly string[], fromWelcome: boolean): Promise<string>;
  switchTab(tabId: string): Promise<void>;
  renameTab(tabId: string, name: string): Promise<void>;
  closeTab(tabId: string, answer: 'confirm' | 'cancel'): Promise<void>;
  /** 末尾に打鍵する */
  type(text: string): Promise<void>;
  /** 末尾に外部ペーストする */
  pasteExternal(text: string): Promise<void>;
  /** 全選択 → コピー → 末尾で改行 → ペースト (内部ペースト) */
  internalCopyPaste(): Promise<void>;
  setLanguage(language: ModelLanguage): Promise<void>;
  /** リロードして復元する。タブ 0 本だったときは casual が既定タブを作るので、その id を返す。 */
  reload(hadNoTabs: boolean): Promise<string | null>;
  focusLossAndReturn(): Promise<void>;
  /** 現タブを export し、verify-cli (--mode fast) の判定と proof の中身を `tab` と突き合わせる。 */
  exportCurrentTab(tab: Readonly<ModelTab>): Promise<void>;
  /** モデルと実アプリの状態が一致することを確かめる (各手の後)。件数の最大値はここで更新する。 */
  expectMatches(model: EditorModel): Promise<void>;
}

type ModelCommand = fc.AsyncCommand<EditorModel, EditorDriver, false>;

/** 1 手 = ドライバで操作 → モデルを進める → 突き合わせ。 */
abstract class EditorCommand implements ModelCommand {
  abstract check(m: Readonly<EditorModel>): boolean;
  protected abstract step(m: EditorModel, d: EditorDriver): Promise<void>;
  abstract toString(): string;

  async run(m: EditorModel, d: EditorDriver): Promise<void> {
    // 手の前に出す (ハングやテストのタイムアウトで落ちても、どこまで進んだかが出力に残る)。
    d.log(this.toString());
    await this.step(m, d);
    await d.expectMatches(m);
  }
}

/** タブ数の剰余で対象を選ぶ (縮約で手前のタブが減っても別のタブを指すだけで、手は捨てない)。 */
function pick(m: Readonly<EditorModel>, index: number): ModelTab {
  const tab = m.tabs[index % m.tabs.length];
  if (!tab) throw new Error('pick() on a model without tabs (check() should have excluded this)');
  return tab;
}

export class AddTab extends EditorCommand {
  check(m: Readonly<EditorModel>): boolean {
    return m.tabs.length < MAX_TABS;
  }
  protected async step(m: EditorModel, d: EditorDriver): Promise<void> {
    const name = nextUntitledName(m);
    const id = await d.addTab(
      m.tabs.map((t) => t.id),
      m.tabs.length === 0
    );
    // 新しいタブは末尾に並び、アクティブになる。
    m.tabs.push(newTab(id, name));
    m.activeId = id;
  }
  toString(): string {
    return 'AddTab()';
  }
}

export class SwitchTab extends EditorCommand {
  constructor(readonly index: number) {
    super();
  }
  check(m: Readonly<EditorModel>): boolean {
    return m.tabs.length >= 2;
  }
  protected async step(m: EditorModel, d: EditorDriver): Promise<void> {
    const target = pick(m, this.index);
    await d.switchTab(target.id);
    m.activeId = target.id;
  }
  toString(): string {
    return `SwitchTab(${this.index})`;
  }
}

export class RenameTab extends EditorCommand {
  constructor(
    readonly index: number,
    readonly name: string
  ) {
    super();
  }
  check(m: Readonly<EditorModel>): boolean {
    return m.tabs.length >= 1;
  }
  protected async step(m: EditorModel, d: EditorDriver): Promise<void> {
    const target = pick(m, this.index);
    await d.renameTab(target.id, this.name);
    target.name = this.name;
    // ダブルクリックの 1 回目がシングルクリックとしてタブを切り替える。
    m.activeId = target.id;
  }
  toString(): string {
    return `RenameTab(${this.index}, ${JSON.stringify(this.name)})`;
  }
}

export class CloseTab extends EditorCommand {
  constructor(
    readonly index: number,
    readonly answer: 'confirm' | 'cancel'
  ) {
    super();
  }
  check(m: Readonly<EditorModel>): boolean {
    return m.tabs.length >= 1;
  }
  protected async step(m: EditorModel, d: EditorDriver): Promise<void> {
    const target = pick(m, this.index);
    await d.closeTab(target.id, this.answer);
    if (this.answer === 'cancel') return;
    m.tabs = m.tabs.filter((t) => t.id !== target.id);
    if (m.tabs.length === 0) {
      // 最後のタブを閉じるとウェルカム画面になる。
      m.activeId = null;
    } else if (m.activeId === target.id) {
      // アクティブなタブを閉じると、残ったうち先頭のタブがアクティブになる。
      m.activeId = m.tabs[0]!.id;
    }
  }
  toString(): string {
    return `CloseTab(${this.index}, ${this.answer})`;
  }
}

export class Type extends EditorCommand {
  constructor(readonly text: string) {
    super();
  }
  check(m: Readonly<EditorModel>): boolean {
    return m.tabs.length >= 1;
  }
  protected async step(m: EditorModel, d: EditorDriver): Promise<void> {
    await d.type(this.text);
    activeTab(m)!.content += this.text;
  }
  toString(): string {
    return `Type(${JSON.stringify(this.text)})`;
  }
}

export class PasteExternal extends EditorCommand {
  private pasted: string | null = null;
  constructor(readonly suffix: string) {
    super();
  }
  check(m: Readonly<EditorModel>): boolean {
    return m.tabs.length >= 1;
  }
  protected async step(m: EditorModel, d: EditorDriver): Promise<void> {
    // どのタブの内容にも現れない文字列にする (含まれていると内部ペーストに格下げされる =
    // SessionContentRegistry の部分一致)。打鍵は英小文字だけなので大文字 + 通し番号で一意になる。
    const text = `EXT${m.pasteSeq}_${this.suffix}`;
    m.pasteSeq += 1;
    this.pasted = text;
    d.log(`  pasting ${JSON.stringify(text)}`);
    await d.pasteExternal(text);
    const tab = activeTab(m)!;
    tab.content += text;
    tab.externalPaste = true;
  }
  toString(): string {
    return `PasteExternal(${JSON.stringify(this.pasted ?? `EXT?_${this.suffix}`)})`;
  }
}

export class InternalCopyPaste extends EditorCommand {
  check(m: Readonly<EditorModel>): boolean {
    const tab = activeTab(m);
    return tab !== undefined && tab.content.length > 0 && tab.content.length <= MAX_COPY_SOURCE_LENGTH;
  }
  protected async step(m: EditorModel, d: EditorDriver): Promise<void> {
    await d.internalCopyPaste();
    const tab = activeTab(m)!;
    tab.content = `${tab.content}\n${tab.content}`;
  }
  toString(): string {
    return 'InternalCopyPaste()';
  }
}

export class SetLanguage extends EditorCommand {
  constructor(readonly language: ModelLanguage) {
    super();
  }
  check(m: Readonly<EditorModel>): boolean {
    return m.tabs.length >= 1;
  }
  protected async step(m: EditorModel, d: EditorDriver): Promise<void> {
    await d.setLanguage(this.language);
    activeTab(m)!.language = this.language;
  }
  toString(): string {
    return `SetLanguage(${this.language})`;
  }
}

export class Reload extends EditorCommand {
  check(): boolean {
    return true;
  }
  protected async step(m: EditorModel, d: EditorDriver): Promise<void> {
    const hadNoTabs = m.tabs.length === 0;
    // 名前は reload の前に決める (タブ 0 本なら Untitled-1)。
    const name = nextUntitledName(m);
    const createdId = await d.reload(hadNoTabs);
    if (hadNoTabs) {
      // casual はタブ 0 本で起動すると既定タブを 1 本開く (ADR-0015)。
      if (!createdId) throw new Error('reload with no tabs should create the default tab');
      m.tabs.push(newTab(createdId, name));
      m.activeId = createdId;
    }
    // それ以外は全部そのまま復元される (順序・active・内容・言語・名前)。
  }
  toString(): string {
    return 'Reload()';
  }
}

export class FocusLoss extends EditorCommand {
  check(): boolean {
    return true;
  }
  protected async step(_m: EditorModel, d: EditorDriver): Promise<void> {
    await d.focusLossAndReturn();
  }
  toString(): string {
    return 'FocusLoss()';
  }
}

export class ExportCurrentTab extends EditorCommand {
  check(m: Readonly<EditorModel>): boolean {
    // 空のタブも export する (空のソースを含む ZIP が verify-cli で pass することも見る / #447)。
    return m.tabs.length >= 1;
  }
  protected async step(m: EditorModel, d: EditorDriver): Promise<void> {
    await d.exportCurrentTab(activeTab(m)!);
  }
  toString(): string {
    return 'ExportCurrentTab()';
  }
}

/** 識別子 (英小文字 1〜4 字)。 */
const identifier = fc.stringMatching(/^[a-z]{1,4}$/);
/** 1 文 = `id = 数字;` (行頭空白も括弧も `:` も出さない)。 */
const statement = fc.tuple(identifier, fc.integer({ min: 0, max: 999 })).map(([id, n]) => `${id} = ${n};`);
/** 打鍵する文字列: 1〜3 文を空白か改行でつなぎ、末尾に改行を付けることがある。 */
const typedText = fc
  .tuple(fc.array(fc.tuple(statement, fc.constantFrom(' ', '\n')), { minLength: 1, maxLength: 3 }), fc.boolean())
  .map(([parts, trailingNewline]) => {
    const body = parts.map(([s, sep], i) => (i === parts.length - 1 ? s : s + sep)).join('');
    return trailingNewline ? `${body}\n` : body;
  });

/** 改名後の名前 (英小文字始まり。`Untitled-N` の採番に絡まないよう `-` を含めない)。 */
const tabName = fc.stringMatching(/^[a-z][a-z0-9_]{0,7}$/);

/**
 * コマンドの生成器。打鍵は他より多く選ばれるよう 2 つ置く (fc.commands は配列から一様に選ぶ)。
 * 外部ペーストの接尾辞は縮約で縮めない (同じ文字列が 2 回ペーストされると内部扱いに変わるため)。
 */
export function editorCommandArbitraries(): fc.Arbitrary<ModelCommand>[] {
  const index = fc.nat({ max: MAX_TABS - 1 });
  return [
    fc.constant(new AddTab()),
    index.map((i) => new SwitchTab(i)),
    fc.tuple(index, tabName).map(([i, n]) => new RenameTab(i, n)),
    index.map((i) => new CloseTab(i, 'confirm')),
    index.map((i) => new CloseTab(i, 'cancel')),
    typedText.map((t) => new Type(t)),
    typedText.map((t) => new Type(t)),
    fc.noShrink(fc.stringMatching(/^[A-Z]{6}$/)).map((s) => new PasteExternal(s)),
    fc.constant(new InternalCopyPaste()),
    fc.constantFrom(...MODEL_LANGUAGES).map((l) => new SetLanguage(l)),
    fc.constant(new Reload()),
    fc.constant(new FocusLoss()),
    fc.constant(new ExportCurrentTab()),
  ];
}
