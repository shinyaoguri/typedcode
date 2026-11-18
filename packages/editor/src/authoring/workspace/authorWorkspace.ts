/**
 * 作問画面 (`/author`) の状態 (#796 / ADR-0051、docs/system-spec.md §4.10)。DOM・Monaco に触れない。
 *
 * 開いた教材フォルダについて、次の 3 つを持つ:
 * - **索引**: ファイル一覧、問題定義 (`*.problem.yaml`) の parse 結果と参照先の解決、試験定義 (`*.exam.yaml`) の一覧。
 *   読めない定義は理由つきで残す (一覧から黙って消さない)。`refresh()` で読み直す
 * - **文書**: 開いているファイルごとの「保存済みのテキスト・今のテキスト・未保存か」。保存は `MaterialFolder` の結果
 *   (`saved` / `conflict` / `failed`) をそのまま返し、競合・失敗では手元の編集を残す
 * - **問題の操作**: 問題を作る、要素 (初期コード・ヒント・解答例・ケース) を新しいファイルで足す、既存のファイルを割り当てる。
 *   問題定義の書き戻しは「ディスクの今の定義を読む → 差分を当てる → その場で保存」で行い、未保存の編集として溜めない。
 *   その定義を文書として開いていて未保存の編集があるときは、書かずに `definition-dirty` を返す
 *
 * パスは教材フォルダの根からの相対 POSIX パス。macOS や同期フォルダでは `listFiles` が濁点を分解した形 (NFD) で
 * 返すことがあるので、**参照と一覧の突き合わせは NFC にそろえて比べ**、ファイルに書く綴りとフォルダの API に渡すパスは
 * 一覧の綴りのまま保つ。
 *
 * 索引と書き出しの読み込みは、文書として開いているファイルならディスクでなく文書の保存済みのテキストを使う。
 * `MaterialFolder.readText` は読んだときの `lastModified` を覚え直すので、開いている文書のファイルを裏で読み直すと、
 * その後の保存で外部の変更を競合として検出できなくなるため。
 */

import type { ExamBundleProblem } from '@typedcode/shared';
import {
  createCasesDefinitionText,
  createProblemDefinitionText,
  type DefinitionIssue,
  parseProblemDefinition,
  type ProblemDefinition,
  type ProblemDefinitionPatch,
  updateProblemDefinitionText,
} from './definitions.js';
import { buildBundleProblemsFromPaths, type WorkspaceIssue } from './examBundle.js';
import type { FolderWriteResult, WriteTextOptions } from './materialFolder.js';
import {
  problemIdFromPath,
  type ReferenceRejection,
  relativeWorkspaceReference,
  resolveWorkspaceReference,
  workspaceBasename,
} from './paths.js';
import type { WorkspaceReader } from './reader.js';

/** 作問画面が使うフォルダの操作 (`MaterialFolder` が満たす)。 */
export interface WorkspaceFolder extends WorkspaceReader {
  readonly name: string;
  listFiles(): Promise<string[]>;
  writeText(path: string, text: string, options?: WriteTextOptions): Promise<FolderWriteResult>;
  createFile(path: string, text?: string): Promise<FolderWriteResult>;
}

export const PROBLEM_DEFINITION_SUFFIX = '.problem.yaml';
export const EXAM_DEFINITION_SUFFIX = '.exam.yaml';

/** 問題定義が参照するファイルの役割。 */
export type ProblemPartRole = 'statement' | 'starter' | 'hint' | 'solution' | 'cases';
/** 後から足せる役割 (本文は問題を作るときに決まる)。 */
export type AddableRole = Exclude<ProblemPartRole, 'statement'>;
export const ADDABLE_ROLES: readonly AddableRole[] = ['starter', 'hint', 'solution', 'cases'];

/** 問題定義の参照 1 つ。 */
export interface ProblemPart {
  readonly role: ProblemPartRole;
  /** 定義ファイルに書かれたままの参照 */
  readonly reference: string;
  /** 根からの相対パス。在れば一覧の綴り。参照が解決できなければ null */
  readonly path: string | null;
  readonly exists: boolean;
  /** 参照を解決できなかった理由 (`path` が null のとき) */
  readonly rejection?: ReferenceRejection;
}

export type IndexedProblem =
  | {
      readonly status: 'ok';
      readonly path: string;
      readonly definition: ProblemDefinition;
      /** 本文・初期コード・ヒント・解答例・ケースの順 */
      readonly parts: readonly ProblemPart[];
    }
  | { readonly status: 'invalid'; readonly path: string; readonly issues: readonly DefinitionIssue[] }
  | { readonly status: 'unreadable'; readonly path: string; readonly message: string };

export interface WorkspaceIndex {
  /** すべてのファイル (一覧の綴り・パス順) */
  readonly files: readonly string[];
  /** 問題定義 (パス順) */
  readonly problems: readonly IndexedProblem[];
  /** 試験定義のパス (パス順) */
  readonly exams: readonly string[];
}

export interface WorkspaceDocument {
  readonly path: string;
  /** 最後に読んだ / 保存したテキスト */
  readonly savedText: string;
  /** 今のテキスト */
  readonly text: string;
  readonly dirty: boolean;
}

export type OpenDocumentResult =
  | { readonly ok: true; readonly document: WorkspaceDocument }
  | { readonly ok: false; readonly path: string; readonly cause: unknown };

/** 問題の操作が失敗した理由。 */
export type WorkspaceOpError =
  /** 名前・ファイル名がパスとして使えない (空・`..`・`\`・`.` で始まる区間など) */
  | { readonly kind: 'invalid-name'; readonly name: string }
  /** 作ろうとしたファイルが既に在る */
  | { readonly kind: 'exists'; readonly path: string }
  /** 問題定義が索引に無い */
  | { readonly kind: 'unknown-problem'; readonly path: string }
  /** 問題定義を文書として開いていて未保存の編集がある (先に保存か読み直しを) */
  | { readonly kind: 'definition-dirty'; readonly path: string }
  /** 問題定義が読めない形 */
  | { readonly kind: 'definition-invalid'; readonly path: string; readonly issues: readonly DefinitionIssue[] }
  /** 初期コード・ケースが既にある、または同じファイルが既にその役割に入っている */
  | { readonly kind: 'already-assigned'; readonly role: AddableRole; readonly path: string }
  /** 割り当てるファイルがフォルダに無い */
  | { readonly kind: 'missing-file'; readonly path: string }
  | { readonly kind: 'read-failed'; readonly path: string; readonly cause: unknown }
  /** 書き込みが競合・失敗した (結果をそのまま持つ) */
  | {
      readonly kind: 'write-failed';
      readonly result: Exclude<FolderWriteResult, { status: 'saved' }>;
    };

export type WorkspaceOpResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly error: WorkspaceOpError };

/** 書き出し用の問題列を作った結果。 */
export type WorkspaceBundleResult =
  /** 未保存の文書がある (書き出さない) */
  | { readonly status: 'dirty'; readonly paths: readonly string[] }
  /** 問題定義が 1 つも無い */
  | { readonly status: 'empty' }
  /** 欠損・重複・読めない定義がある */
  | { readonly status: 'invalid'; readonly issues: readonly WorkspaceIssue[] }
  | { readonly status: 'ok'; readonly problems: ExamBundleProblem[] };

export type WorkspaceChange =
  | { readonly kind: 'index' }
  /** 文書のテキスト・保存済みのテキストが変わった (開いた・閉じたも含む) */
  | { readonly kind: 'document'; readonly path: string };

interface DocumentRecord {
  path: string;
  savedText: string;
  text: string;
}

function nfc(path: string): string {
  return path.normalize('NFC');
}

function snapshot(record: DocumentRecord): WorkspaceDocument {
  return {
    path: record.path,
    savedText: record.savedText,
    text: record.text,
    dirty: record.text !== record.savedText,
  };
}

/** 作る・足すファイルの名前として受け付けるか (`MaterialFolder` の規則に加え、`.` で始まる区間を拒む)。 */
function isUsablePath(path: string): boolean {
  if (path === '' || path.includes('\\')) return false;
  // 一覧は `.` で始まるファイル・フォルダを飛ばすので、作っても見えなくなる
  return path.split('/').every((segment) => segment !== '' && !segment.startsWith('.'));
}

function isDefinitionPath(path: string): boolean {
  return path.endsWith(PROBLEM_DEFINITION_SUFFIX) || path.endsWith(EXAM_DEFINITION_SUFFIX);
}

function fail(error: WorkspaceOpError): WorkspaceOpResult {
  return { ok: false, error };
}

function writeFailure(result: FolderWriteResult): WorkspaceOpError | null {
  if (result.status === 'saved') return null;
  if (result.status === 'conflict' && result.reason === 'exists') return { kind: 'exists', path: result.path };
  return { kind: 'write-failed', result };
}

export class AuthorWorkspace {
  /** NFC にそろえたパス → 一覧の綴り */
  private listed = new Map<string, string>();
  private currentIndex: WorkspaceIndex = { files: [], problems: [], exams: [] };
  private refreshGeneration = 0;
  /** 一覧の綴り → 文書 */
  private readonly docs = new Map<string, DocumentRecord>();
  private readonly listeners = new Set<(change: WorkspaceChange) => void>();

  constructor(private readonly folder: WorkspaceFolder) {}

  get folderName(): string {
    return this.folder.name;
  }

  get index(): WorkspaceIndex {
    return this.currentIndex;
  }

  /** 変更を聞く。返り値で外す */
  onChange(listener: (change: WorkspaceChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: WorkspaceChange): void {
    for (const listener of this.listeners) listener(change);
  }

  /** パスを一覧の綴りにする (NFC で照合)。一覧に無ければ undefined */
  listedPath(path: string): string | undefined {
    return this.listed.get(nfc(path));
  }

  /** 一覧に在れば一覧の綴り、無ければ渡された綴り */
  private actual(path: string): string {
    return this.listedPath(path) ?? path;
  }

  // ==========================================================================
  // 索引
  // ==========================================================================

  /** フォルダを読み直して索引を作り直す */
  async refresh(): Promise<WorkspaceIndex> {
    const generation = ++this.refreshGeneration;
    const files = await this.folder.listFiles();
    const listed = new Map(files.map((file) => [nfc(file), file] as const));
    const problems: IndexedProblem[] = [];
    for (const path of files) {
      if (!path.endsWith(PROBLEM_DEFINITION_SUFFIX)) continue;
      problems.push(await this.indexProblem(path, listed));
    }
    const exams = files.filter((path) => path.endsWith(EXAM_DEFINITION_SUFFIX));
    // 後から始まった読み直しが先に終わっていれば、古い結果で上書きしない
    if (generation === this.refreshGeneration) {
      this.listed = listed;
      this.currentIndex = { files, problems, exams };
      this.emit({ kind: 'index' });
    }
    return this.currentIndex;
  }

  /** 問題定義 (一覧の綴りでも NFC でもよい) */
  problem(path: string): IndexedProblem | undefined {
    const key = nfc(path);
    return this.currentIndex.problems.find((problem) => nfc(problem.path) === key);
  }

  private async indexProblem(path: string, listed: ReadonlyMap<string, string>): Promise<IndexedProblem> {
    let text: string;
    try {
      text = await this.readForIndex(path);
    } catch (error) {
      return { status: 'unreadable', path, message: error instanceof Error ? error.message : String(error) };
    }
    const parsed = parseProblemDefinition(text);
    if (!parsed.ok) return { status: 'invalid', path, issues: parsed.issues };
    const definition = parsed.value;
    const part = (role: ProblemPartRole, reference: string): ProblemPart => {
      const resolved = resolveWorkspaceReference(path, reference);
      if (!resolved.ok) return { role, reference, path: null, exists: false, rejection: resolved.reason };
      const found = listed.get(nfc(resolved.path));
      return { role, reference, path: found ?? resolved.path, exists: found !== undefined };
    };
    const parts: ProblemPart[] = [part('statement', definition.statement)];
    if (definition.starter !== undefined) parts.push(part('starter', definition.starter));
    for (const hint of definition.hints) parts.push(part('hint', hint));
    for (const solution of definition.solutions) parts.push(part('solution', solution));
    if (definition.cases !== undefined) parts.push(part('cases', definition.cases));
    return { status: 'ok', path, definition, parts };
  }

  /** 索引・書き出し用の読み込み。開いている文書は保存済みのテキストを返す (ファイルの冒頭の説明) */
  private async readForIndex(path: string): Promise<string> {
    const doc = this.docs.get(path);
    if (doc) return doc.savedText;
    return this.folder.readText(path);
  }

  /** 書き出し (`buildBundleProblemsFromPaths`) が読む口。照合は NFC、在るかは索引で答える */
  reader(): WorkspaceReader {
    return {
      readText: (path) => this.readForIndex(this.actual(path)),
      exists: async (path) => this.listedPath(path) !== undefined,
    };
  }

  /**
   * 開いたフォルダの問題定義すべて (パス順) を配布物の問題列にする。未保存の文書があれば作らない。
   * 索引を読み直してから作る。
   */
  async buildBundle(): Promise<WorkspaceBundleResult> {
    const dirty = this.dirtyPaths();
    if (dirty.length > 0) return { status: 'dirty', paths: dirty };
    const index = await this.refresh();
    const paths = index.problems.map((problem) => problem.path);
    if (paths.length === 0) return { status: 'empty' };
    const result = await buildBundleProblemsFromPaths(paths, this.reader());
    return result.ok ? { status: 'ok', problems: result.problems } : { status: 'invalid', issues: result.issues };
  }

  // ==========================================================================
  // 文書
  // ==========================================================================

  /** ファイルを文書として開く (開いていればそれを返す) */
  async open(path: string): Promise<OpenDocumentResult> {
    const actual = this.actual(path);
    const existing = this.docs.get(actual);
    if (existing) return { ok: true, document: snapshot(existing) };
    let text: string;
    try {
      text = await this.folder.readText(actual);
    } catch (cause) {
      return { ok: false, path: actual, cause };
    }
    // 読んでいる間に別の呼び出しが開いていたら、そちらを使う
    const raced = this.docs.get(actual);
    if (raced) return { ok: true, document: snapshot(raced) };
    const record: DocumentRecord = { path: actual, savedText: text, text };
    this.docs.set(actual, record);
    this.emit({ kind: 'document', path: actual });
    return { ok: true, document: snapshot(record) };
  }

  document(path: string): WorkspaceDocument | undefined {
    const record = this.docs.get(this.actual(path));
    return record ? snapshot(record) : undefined;
  }

  documents(): WorkspaceDocument[] {
    return [...this.docs.values()].map(snapshot);
  }

  /** 文書の今のテキストを変える (開いていなければ何もしない) */
  setText(path: string, text: string): WorkspaceDocument | undefined {
    const record = this.docs.get(this.actual(path));
    if (!record) return undefined;
    if (record.text !== text) {
      record.text = text;
      this.emit({ kind: 'document', path: record.path });
    }
    return snapshot(record);
  }

  dirtyPaths(): string[] {
    return [...this.docs.values()].filter((doc) => doc.text !== doc.savedText).map((doc) => doc.path);
  }

  dirtyCount(): number {
    return this.dirtyPaths().length;
  }

  /**
   * 文書を保存する。外部で変わった・消えたファイルは `overwrite` が無ければ書かずに `conflict` を返す。
   * 競合・失敗では今のテキストを残す (未保存のまま)。
   */
  async save(path: string, options: WriteTextOptions = {}): Promise<FolderWriteResult> {
    const record = this.docs.get(this.actual(path));
    if (!record) return { status: 'failed', path, cause: new Error(`not open: ${path}`) };
    // 書いている間に打たれた分は未保存として残す
    const text = record.text;
    const result = await this.folder.writeText(record.path, text, options);
    if (result.status === 'saved') {
      record.savedText = text;
      this.emit({ kind: 'document', path: record.path });
      if (isDefinitionPath(record.path)) await this.refresh();
    }
    return result;
  }

  /** 未保存の文書をすべて保存する (競合・失敗は文書ごとに返し、続く文書も試す) */
  async saveAll(): Promise<FolderWriteResult[]> {
    const results: FolderWriteResult[] = [];
    for (const path of this.dirtyPaths()) results.push(await this.save(path));
    return results;
  }

  /** 手元の編集を捨ててディスクから読み直す */
  async reload(path: string): Promise<OpenDocumentResult> {
    const record = this.docs.get(this.actual(path));
    if (!record) return this.open(path);
    let text: string;
    try {
      text = await this.folder.readText(record.path);
    } catch (cause) {
      return { ok: false, path: record.path, cause };
    }
    record.savedText = text;
    record.text = text;
    this.emit({ kind: 'document', path: record.path });
    if (isDefinitionPath(record.path)) await this.refresh();
    return { ok: true, document: snapshot(record) };
  }

  /** 文書を閉じる (未保存の編集は捨てる。確かめるのは呼び出し側) */
  close(path: string): void {
    const actual = this.actual(path);
    if (this.docs.delete(actual)) this.emit({ kind: 'document', path: actual });
  }

  // ==========================================================================
  // 問題の操作
  // ==========================================================================

  /**
   * 問題を作る。`name` はファイル名の語幹 (`a/b` のようにサブフォルダを含めてよい)。`<name>.md` (見出し 1 行の本文) と
   * `<name>.problem.yaml` を作る。どちらかが既に在れば何も作らない。
   */
  async createProblem(name: string): Promise<WorkspaceOpResult> {
    let stem = name.trim();
    if (stem.endsWith(PROBLEM_DEFINITION_SUFFIX)) stem = stem.slice(0, -PROBLEM_DEFINITION_SUFFIX.length);
    if (!isUsablePath(stem)) return fail({ kind: 'invalid-name', name });
    const definitionPath = `${stem}${PROBLEM_DEFINITION_SUFFIX}`;
    const statementPath = `${stem}.md`;
    await this.refresh();
    for (const path of [statementPath, definitionPath]) {
      const found = this.listedPath(path);
      if (found !== undefined) return fail({ kind: 'exists', path: found });
    }
    const base = workspaceBasename(stem);
    const definition = createProblemDefinitionText({
      id: problemIdFromPath(definitionPath),
      statement: `${base}.md`,
      hints: [],
      solutions: [],
    });
    if (!definition.ok) return fail({ kind: 'definition-invalid', path: definitionPath, issues: definition.issues });

    const statement = await this.folder.createFile(statementPath, `# ${base}\n`);
    const statementError = writeFailure(statement);
    if (statementError) return fail(statementError);
    const created = await this.folder.createFile(definitionPath, definition.text);
    const createdError = writeFailure(created);
    await this.refresh();
    if (createdError) return fail(createdError);
    return { ok: true, path: definitionPath };
  }

  /**
   * 問題に要素を新しいファイルで足す。`name` は問題定義のあるフォルダからの相対パス。ケースは空のケースファイル、
   * それ以外は空のファイルを作り、問題定義を書き戻して保存する。初期コードとケースは 1 つまで。
   */
  async addPart(problemPath: string, role: AddableRole, name: string): Promise<WorkspaceOpResult> {
    const context = await this.definitionContext(problemPath);
    if (!context.ok) return context;
    const capacity = this.checkCapacity(context.value, role);
    if (capacity) return fail(capacity);

    const trimmed = name.trim();
    if (!isUsablePath(trimmed.replace(/^(\.\.\/)+/, ''))) return fail({ kind: 'invalid-name', name });
    const resolved = resolveWorkspaceReference(context.value.path, trimmed);
    if (!resolved.ok || !isUsablePath(resolved.path)) return fail({ kind: 'invalid-name', name });
    const target = resolved.path;
    const found = this.listedPath(target);
    if (found !== undefined) return fail({ kind: 'exists', path: found });

    let content = '';
    if (role === 'cases') {
      const cases = createCasesDefinitionText([]);
      if (!cases.ok) return fail({ kind: 'definition-invalid', path: target, issues: cases.issues });
      content = cases.text;
    }
    const created = await this.folder.createFile(target, content);
    const createdError = writeFailure(created);
    if (createdError) return fail(createdError);

    const reference = relativeWorkspaceReference(context.value.path, target);
    const written = await this.writeDefinition(context.value, role, reference);
    if (!written.ok) {
      await this.refresh();
      return written;
    }
    return { ok: true, path: target };
  }

  /** フォルダに在るファイルを問題の要素に割り当てる (問題定義から見た相対パスを書く) */
  async assignPart(problemPath: string, role: AddableRole, targetPath: string): Promise<WorkspaceOpResult> {
    const context = await this.definitionContext(problemPath);
    if (!context.ok) return context;
    const target = this.listedPath(targetPath);
    if (target === undefined) return fail({ kind: 'missing-file', path: targetPath });
    const capacity = this.checkCapacity(context.value, role);
    if (capacity) return fail(capacity);
    const current = role === 'hint' ? context.value.definition.hints : context.value.definition.solutions;
    if (role === 'hint' || role === 'solution') {
      const already = current.some((reference) => {
        const resolved = resolveWorkspaceReference(context.value.path, reference);
        return resolved.ok && nfc(resolved.path) === nfc(target);
      });
      if (already) return fail({ kind: 'already-assigned', role, path: target });
    }
    const reference = relativeWorkspaceReference(context.value.path, target);
    const written = await this.writeDefinition(context.value, role, reference);
    return written.ok ? { ok: true, path: target } : written;
  }

  private checkCapacity(context: DefinitionContext, role: AddableRole): WorkspaceOpError | null {
    if (role === 'starter' && context.definition.starter !== undefined) {
      return { kind: 'already-assigned', role, path: context.path };
    }
    if (role === 'cases' && context.definition.cases !== undefined) {
      return { kind: 'already-assigned', role, path: context.path };
    }
    return null;
  }

  /** ディスクの今の問題定義を読む。文書として開いていて未保存なら止める */
  private async definitionContext(
    problemPath: string
  ): Promise<{ ok: true; value: DefinitionContext } | { ok: false; error: WorkspaceOpError }> {
    const path = this.listedPath(problemPath);
    if (path === undefined || !path.endsWith(PROBLEM_DEFINITION_SUFFIX)) {
      return { ok: false, error: { kind: 'unknown-problem', path: problemPath } };
    }
    if (this.isDirty(path)) return { ok: false, error: { kind: 'definition-dirty', path } };
    let text: string;
    try {
      text = await this.folder.readText(path);
    } catch (cause) {
      return { ok: false, error: { kind: 'read-failed', path, cause } };
    }
    const parsed = parseProblemDefinition(text);
    if (!parsed.ok) return { ok: false, error: { kind: 'definition-invalid', path, issues: parsed.issues } };
    return { ok: true, value: { path, text, definition: parsed.value } };
  }

  private isDirty(path: string): boolean {
    const record = this.docs.get(path);
    return record !== undefined && record.text !== record.savedText;
  }

  /** 問題定義に参照を 1 つ足して保存する。開いている定義の文書も新しい内容に合わせる */
  private async writeDefinition(
    context: DefinitionContext,
    role: AddableRole,
    reference: string
  ): Promise<WorkspaceOpResult> {
    const { definition } = context;
    const patch: ProblemDefinitionPatch =
      role === 'starter'
        ? { starter: reference }
        : role === 'cases'
          ? { cases: reference }
          : role === 'hint'
            ? { hints: [...definition.hints, reference] }
            : { solutions: [...definition.solutions, reference] };
    const updated = updateProblemDefinitionText(context.text, patch);
    if (!updated.ok) return fail({ kind: 'definition-invalid', path: context.path, issues: updated.issues });
    // 読んでから書くまでの間に定義の文書が編集されていたら書かない
    if (this.isDirty(context.path)) return fail({ kind: 'definition-dirty', path: context.path });
    const result = await this.folder.writeText(context.path, updated.text);
    const error = writeFailure(result);
    if (error) return fail(error);
    const record = this.docs.get(context.path);
    if (record && record.text === record.savedText) {
      record.savedText = updated.text;
      record.text = updated.text;
      this.emit({ kind: 'document', path: record.path });
    }
    await this.refresh();
    return { ok: true, path: context.path };
  }
}

interface DefinitionContext {
  /** 一覧の綴り */
  readonly path: string;
  readonly text: string;
  readonly definition: ProblemDefinition;
}
