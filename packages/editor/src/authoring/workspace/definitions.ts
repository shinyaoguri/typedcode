/**
 * 教材フォルダの定義ファイル (ADR-0051 / system-spec §4.10) の読み書き。
 *
 * - 問題 `*.problem.yaml` (`format: tc-problem/1`)・ケース `*.cases.yaml` (`tc-cases/1`)・
 *   試験 `*.exam.yaml` (`tc-exam/1`) の 3 種
 * - 失敗は例外ではなく `{ ok: false, issues }` で返す。理由は機械可読な種別 + キーで持ち、
 *   人に見せる文言は画面側 (i18n) が作る
 * - `format` が知らない値のファイルは読まず、書き戻しもしない
 * - 書き戻しは `yaml` の Document API で変えたキーだけを差し替え、コメントと未知のキーを残す。
 *   ただし `Document.toString` は全体を AST から描き直すので、空白や引用符の書き方は変わりうる
 * - ケースの `stdin` / `stdout` は値を 1 文字も変えずに往復させる。`yaml` (2.9) は空白だけの行を含む
 *   値を `|+` で書くと読み戻しで値が変わるので、書いた後に読み直して照合し、ずれた値だけ二重引用符で
 *   書き直す (`stabilizeCaseStrings`)
 */

import {
  Document,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  Scalar,
  type Node,
  type Pair,
  type YAMLMap,
  YAMLSeq,
} from 'yaml';

export const PROBLEM_FORMAT = 'tc-problem/1';
export const CASES_FORMAT = 'tc-cases/1';
export const EXAM_FORMAT = 'tc-exam/1';

/** 問題定義。参照はどれも定義ファイルからの相対パス (解決は `paths.ts`)。 */
export interface ProblemDefinition {
  /** 配布物の problemId。作成時にファイル名の語幹で書き、改名で変えない */
  id: string;
  /** 作問画面の表示用 (配らない) */
  title?: string;
  /** 問題文 (Markdown) */
  statement: string;
  /** 初期コード */
  starter?: string;
  /** 教員用のヒント (配らない)。無ければ空配列 */
  hints: string[];
  /** 解答例 (配らない)。1 ファイル = 1 解答。無ければ空配列 */
  solutions: string[];
  /** テストケース (`*.cases.yaml`) */
  cases?: string;
}

/** 教員用の一括検証の比べ方 (§4.10)。既定は `trim`。 */
export type CaseMatch = 'trim' | 'exact';

/** テストケース 1 件 (既定値を埋めた形)。 */
export interface CaseDefinition {
  /** 空でなく、ファイル内で一意 */
  name: string;
  stdin: string;
  stdout: string;
  /** true は配布物の examples に入る。既定 false */
  public: boolean;
  match: CaseMatch;
}

/** 書くときの 1 件。省いた `public` / `match` は既定値。 */
export interface CaseInput {
  name: string;
  stdin: string;
  stdout: string;
  public?: boolean;
  match?: CaseMatch;
}

export type ExamKind = 'exam' | 'class';

/** 試験定義。 */
export interface ExamDefinition {
  /** `.tcexam` の examId / `.tcclass` の classId */
  examId: string;
  kind: ExamKind;
  /** 許可言語 */
  languages: string[];
  /** 採用する問題定義への参照 (出題順) */
  problems: string[];
}

/** 型の期待 (`invalid-type` の `expected`)。 */
export type ExpectedType = 'string' | 'non-empty-string' | 'boolean' | 'string-list' | 'list' | 'mapping';

/**
 * 定義ファイルを読めない・書けない理由。`key` はトップレベルのキー名か、
 * ケースの中なら `cases[2].stdin` の形。
 */
export type DefinitionIssue =
  /** YAML として壊れている */
  | { kind: 'yaml-syntax'; message: string; line?: number }
  /** 最上位がマッピングでない (空ファイルを含む) */
  | { kind: 'not-a-mapping' }
  /** `format` が期待と違う (知らない版・別の種類の定義) */
  | { kind: 'unsupported-format'; found: string; expected: string }
  | { kind: 'missing-key'; key: string }
  | { kind: 'invalid-type'; key: string; expected: ExpectedType }
  /** 決まった値のどれでもない (`match`・`kind`) */
  | { kind: 'invalid-value'; key: string; allowed: readonly string[] }
  /** ケースの `name` が同じファイル内で前のケースと重なる */
  | { kind: 'duplicate-case-name'; key: string; name: string }
  /** 書いた値を読み戻すと一致しない (二重引用符でも保てなかった) */
  | { kind: 'unstable-value'; key: string };

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: DefinitionIssue[] };
export type SerializeResult = { ok: true; text: string } | { ok: false; issues: DefinitionIssue[] };

/** 書き出しの形。flow の列は仕様の例どおり `[a, b]` (括弧の内側に空白を入れない) で書く。 */
const TO_STRING_OPTIONS = { flowCollectionPadding: false } as const;

const CASE_MATCHES: readonly CaseMatch[] = ['trim', 'exact'];
const EXAM_KINDS: readonly ExamKind[] = ['exam', 'class'];

// ============================================================================
// parse
// ============================================================================

/** 問題定義を読む。 */
export function parseProblemDefinition(text: string): ParseResult<ProblemDefinition> {
  const loaded = loadDefinition(text, PROBLEM_FORMAT);
  if (!loaded.ok) return loaded;
  const fields = new FieldReader(loaded.data);
  const id = fields.requiredString('id');
  const title = fields.optionalString('title', false);
  const statement = fields.requiredString('statement');
  const starter = fields.optionalString('starter', true);
  const hints = fields.stringList('hints', false);
  const solutions = fields.stringList('solutions', false);
  const cases = fields.optionalString('cases', true);
  if (fields.issues.length > 0) return { ok: false, issues: fields.issues };
  const value: ProblemDefinition = { id: id!, statement: statement!, hints: hints!, solutions: solutions! };
  if (title !== undefined) value.title = title;
  if (starter !== undefined) value.starter = starter;
  if (cases !== undefined) value.cases = cases;
  return { ok: true, value };
}

/** ケースファイルを読む。`name` の空・重複、`match` の不正も理由に含める。 */
export function parseCasesDefinition(text: string): ParseResult<CaseDefinition[]> {
  const loaded = loadDefinition(text, CASES_FORMAT);
  if (!loaded.ok) return loaded;
  const raw = loaded.data.cases;
  if (raw === undefined || raw === null) return { ok: false, issues: [{ kind: 'missing-key', key: 'cases' }] };
  if (!Array.isArray(raw)) return { ok: false, issues: [{ kind: 'invalid-type', key: 'cases', expected: 'list' }] };

  const issues: DefinitionIssue[] = [];
  const cases: CaseDefinition[] = [];
  const seen = new Set<string>();
  raw.forEach((item: unknown, index) => {
    const prefix = `cases[${index}].`;
    if (!isPlainObject(item)) {
      issues.push({ kind: 'invalid-type', key: `cases[${index}]`, expected: 'mapping' });
      return;
    }
    const fields = new FieldReader(item, prefix);
    const name = fields.requiredString('name');
    const stdin = fields.requiredString('stdin', false);
    const stdout = fields.requiredString('stdout', false);
    const isPublic = fields.optionalBoolean('public') ?? false;
    const match = fields.optionalEnum('match', CASE_MATCHES) ?? 'trim';
    issues.push(...fields.issues);
    if (name !== undefined) {
      if (seen.has(name)) issues.push({ kind: 'duplicate-case-name', key: `${prefix}name`, name });
      seen.add(name);
    }
    if (fields.issues.length === 0) {
      cases.push({ name: name!, stdin: stdin!, stdout: stdout!, public: isPublic, match });
    }
  });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: cases };
}

/** 試験定義を読む。 */
export function parseExamDefinition(text: string): ParseResult<ExamDefinition> {
  const loaded = loadDefinition(text, EXAM_FORMAT);
  if (!loaded.ok) return loaded;
  const fields = new FieldReader(loaded.data);
  const examId = fields.requiredString('examId');
  const kind = fields.requiredEnum('kind', EXAM_KINDS);
  const languages = fields.stringList('languages', true);
  const problems = fields.stringList('problems', true);
  if (fields.issues.length > 0) return { ok: false, issues: fields.issues };
  return { ok: true, value: { examId: examId!, kind: kind!, languages: languages!, problems: problems! } };
}

// ============================================================================
// 新規作成
// ============================================================================

/**
 * 問題定義を何も無いところから作る。`id` は定義ファイルのパスの語幹 (`problemIdFromPath`) を
 * 呼び出し側が渡す。空の `hints` / `solutions` は書かない。
 */
export function createProblemDefinitionText(definition: ProblemDefinition): SerializeResult {
  const doc = new Document({ format: PROBLEM_FORMAT });
  const map = doc.contents as YAMLMap;
  for (const key of PROBLEM_KEYS) setKey(doc, map, key, problemKeyValue(definition, key));
  return finish(doc, parseProblemDefinition, problemExpectation(definition));
}

/** ケースファイルを何も無いところから作る。既定値 (`public: false`・`match: trim`) は書かない。 */
export function createCasesDefinitionText(cases: readonly CaseInput[]): SerializeResult {
  const doc = new Document({ format: CASES_FORMAT, cases: [] });
  const seq = doc.get('cases', true) as YAMLSeq;
  seq.flow = false;
  for (const input of cases) seq.items.push(createCaseNode(doc, normalizeCase(input)));
  return finishCases(doc, cases.map(normalizeCase));
}

/** 試験定義を何も無いところから作る。 */
export function createExamDefinitionText(definition: ExamDefinition): SerializeResult {
  const doc = new Document({ format: EXAM_FORMAT });
  const map = doc.contents as YAMLMap;
  for (const key of EXAM_KEYS) setKey(doc, map, key, definition[key]);
  const problems = map.get('problems', true);
  if (isSeq(problems)) problems.flow = false;
  return finish(doc, parseExamDefinition, examExpectation(definition));
}

// ============================================================================
// 書き戻し (変えたキーだけ)
// ============================================================================

/** 問題定義の差分。値が `undefined` のキーは消す (`hints` / `solutions` は空配列でも消す)。 */
export type ProblemDefinitionPatch = Partial<ProblemDefinition>;
/** 試験定義の差分。 */
export type ExamDefinitionPatch = Partial<ExamDefinition>;

/**
 * 元の問題定義のテキストに差分を当てた新しいテキストを返す。差分で値の変わるキーだけを
 * 差し替え、コメント・未知のキー・キーの順を残す。元が読めない (知らない `format` を含む) なら書かない。
 */
export function updateProblemDefinitionText(text: string, patch: ProblemDefinitionPatch): SerializeResult {
  const current = parseProblemDefinition(text);
  if (!current.ok) return current;
  const next: ProblemDefinition = { ...current.value };
  const doc = parseDocument(text);
  const map = doc.contents as YAMLMap;
  let changed = false;
  for (const key of PROBLEM_KEYS) {
    if (!Object.hasOwn(patch, key)) continue;
    const value = patch[key];
    if (key === 'hints' || key === 'solutions') next[key] = (value as string[] | undefined) ?? [];
    else (next as unknown as Record<string, unknown>)[key] = value;
    if (sameValue(problemKeyValue(current.value, key), problemKeyValue(next, key))) continue;
    setKey(doc, map, key, problemKeyValue(next, key));
    changed = true;
  }
  // 何も変わらないなら描き直さない (描き直すと書き方だけの差分が出る)
  if (!changed) return { ok: true, text };
  return finish(doc, parseProblemDefinition, problemExpectation(next));
}

/** 元の試験定義のテキストに差分を当てた新しいテキストを返す (規則は問題定義と同じ)。 */
export function updateExamDefinitionText(text: string, patch: ExamDefinitionPatch): SerializeResult {
  const current = parseExamDefinition(text);
  if (!current.ok) return current;
  const next: ExamDefinition = { ...current.value };
  const doc = parseDocument(text);
  const map = doc.contents as YAMLMap;
  let changed = false;
  for (const key of EXAM_KEYS) {
    if (!Object.hasOwn(patch, key)) continue;
    const value = patch[key];
    if (value === undefined) {
      // 必須キーは消せない。消した結果は検証で missing-key として返る
      map.delete(key);
      changed = true;
      continue;
    }
    (next as unknown as Record<string, unknown>)[key] = value;
    if (sameValue(current.value[key], value)) continue;
    setKey(doc, map, key, value);
    changed = true;
  }
  if (!changed) return { ok: true, text };
  return finish(doc, parseExamDefinition, examExpectation(next));
}

/**
 * 元のケースファイルのテキストを、`cases` が与えた並びになるよう書き換える。添字ごとに欄を比べ、
 * 変わった欄だけを差し替える (各ケースのコメントと未知のキーを残す)。増えた分は末尾に足し、減った分は消す。
 */
export function updateCasesDefinitionText(text: string, cases: readonly CaseInput[]): SerializeResult {
  const current = parseCasesDefinition(text);
  if (!current.ok) return current;
  const desired = cases.map(normalizeCase);
  if (JSON.stringify(desired) === JSON.stringify(current.value)) return { ok: true, text };
  const doc = parseDocument(text);
  const seq = doc.get('cases', true) as YAMLSeq;
  desired.forEach((next, index) => {
    const node = seq.items[index];
    const previous = current.value[index];
    if (previous && isMap(node)) {
      updateCaseNode(doc, node, previous, next);
    } else {
      // flow の列にブロックのマッピングは足せないので、足すときはブロックにする
      seq.flow = false;
      seq.items.push(createCaseNode(doc, next));
    }
  });
  seq.items.splice(desired.length);
  return finishCases(doc, desired);
}

// ============================================================================
// 内部
// ============================================================================

const PROBLEM_KEYS = ['id', 'title', 'statement', 'starter', 'hints', 'solutions', 'cases'] as const;
type ProblemKey = (typeof PROBLEM_KEYS)[number];
const EXAM_KEYS = ['examId', 'kind', 'languages', 'problems'] as const;

/** ファイルに書く値。空の `hints` / `solutions` は書かない (= undefined)。 */
function problemKeyValue(definition: ProblemDefinition, key: ProblemKey): unknown {
  const value = definition[key];
  if (Array.isArray(value) && value.length === 0) return undefined;
  return value;
}

/** 読み戻した結果と比べる形 (`undefined` の任意キーは持たない)。 */
function problemExpectation(definition: ProblemDefinition): ProblemDefinition {
  const out: ProblemDefinition = {
    id: definition.id,
    statement: definition.statement,
    hints: [...definition.hints],
    solutions: [...definition.solutions],
  };
  if (definition.title !== undefined) out.title = definition.title;
  if (definition.starter !== undefined) out.starter = definition.starter;
  if (definition.cases !== undefined) out.cases = definition.cases;
  return out;
}

function examExpectation(definition: ExamDefinition): ExamDefinition {
  return {
    examId: definition.examId,
    kind: definition.kind,
    languages: [...definition.languages],
    problems: [...definition.problems],
  };
}

function normalizeCase(input: CaseInput): CaseDefinition {
  return {
    name: input.name,
    stdin: input.stdin,
    stdout: input.stdout,
    public: input.public ?? false,
    match: input.match ?? 'trim',
  };
}

type Loaded = { ok: true; data: Record<string, unknown> } | { ok: false; issues: DefinitionIssue[] };

/** YAML を読み、最上位がマッピングで `format` が期待どおりかを確かめる。 */
function loadDefinition(text: string, expectedFormat: string): Loaded {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    return {
      ok: false,
      issues: doc.errors.map((error) => {
        const issue: DefinitionIssue = { kind: 'yaml-syntax', message: error.message };
        const line = error.linePos?.[0]?.line;
        if (line !== undefined) issue.line = line;
        return issue;
      }),
    };
  }
  let data: unknown;
  try {
    data = doc.toJS();
  } catch (error) {
    // エイリアスの展開しすぎ (maxAliasCount) などは toJS で投げる
    return {
      ok: false,
      issues: [{ kind: 'yaml-syntax', message: error instanceof Error ? error.message : String(error) }],
    };
  }
  if (!isPlainObject(data)) return { ok: false, issues: [{ kind: 'not-a-mapping' }] };
  const format = data.format;
  if (format === undefined || format === null) return { ok: false, issues: [{ kind: 'missing-key', key: 'format' }] };
  if (format !== expectedFormat) {
    return { ok: false, issues: [{ kind: 'unsupported-format', found: String(format), expected: expectedFormat }] };
  }
  return { ok: true, data };
}

/** マッピングから型を確かめながら値を取り出し、問題を `issues` に溜める。null は「無い」と同じに扱う。 */
class FieldReader {
  readonly issues: DefinitionIssue[] = [];

  constructor(
    private readonly data: Record<string, unknown>,
    private readonly prefix = ''
  ) {}

  requiredString(key: string, nonEmpty = true): string | undefined {
    const value = this.data[key];
    if (value === undefined || value === null) {
      this.issues.push({ kind: 'missing-key', key: this.prefix + key });
      return undefined;
    }
    return this.checkString(key, value, nonEmpty);
  }

  optionalString(key: string, nonEmpty: boolean): string | undefined {
    const value = this.data[key];
    if (value === undefined || value === null) return undefined;
    return this.checkString(key, value, nonEmpty);
  }

  optionalBoolean(key: string): boolean | undefined {
    const value = this.data[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'boolean') return value;
    this.issues.push({ kind: 'invalid-type', key: this.prefix + key, expected: 'boolean' });
    return undefined;
  }

  requiredEnum<T extends string>(key: string, allowed: readonly T[]): T | undefined {
    const value = this.data[key];
    if (value === undefined || value === null) {
      this.issues.push({ kind: 'missing-key', key: this.prefix + key });
      return undefined;
    }
    return this.checkEnum(key, value, allowed);
  }

  optionalEnum<T extends string>(key: string, allowed: readonly T[]): T | undefined {
    const value = this.data[key];
    if (value === undefined || value === null) return undefined;
    return this.checkEnum(key, value, allowed);
  }

  /** 空でない文字列の列。`required` でなければ無いときは空配列。 */
  stringList(key: string, required: boolean): string[] | undefined {
    const value = this.data[key];
    if (value === undefined || value === null) {
      if (!required) return [];
      this.issues.push({ kind: 'missing-key', key: this.prefix + key });
      return undefined;
    }
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim() !== '')) {
      this.issues.push({ kind: 'invalid-type', key: this.prefix + key, expected: 'string-list' });
      return undefined;
    }
    return value as string[];
  }

  private checkString(key: string, value: unknown, nonEmpty: boolean): string | undefined {
    if (typeof value === 'string' && (!nonEmpty || value.trim() !== '')) return value;
    this.issues.push({
      kind: 'invalid-type',
      key: this.prefix + key,
      expected: nonEmpty ? 'non-empty-string' : 'string',
    });
    return undefined;
  }

  private checkEnum<T extends string>(key: string, value: unknown, allowed: readonly T[]): T | undefined {
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
    this.issues.push({ kind: 'invalid-value', key: this.prefix + key, allowed });
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => item === b[i]);
  return a === b;
}

function findPair(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((pair) => (isScalar(pair.key) ? pair.key.value === key : pair.key === key)) as Pair | undefined;
}

/**
 * キー 1 つを差し替える。`undefined` は消す。既存の節点はできるだけ使い回す
 * (スカラーは値だけ書き換え、列は同じ値の項目を残して flow かどうかも保つ) ので、
 * 節点に付いたコメントが残る。無いキーは末尾に足す。
 */
function setKey(doc: Document, map: YAMLMap, key: string, value: unknown): void {
  if (value === undefined) {
    map.delete(key);
    return;
  }
  const pair = findPair(map, key);
  if (!pair) {
    const node = doc.createNode(value);
    // 新しく書く文字列の列 (hints / solutions / languages) は仕様の例に合わせて flow で書く
    if (isSeq(node)) node.flow = true;
    map.set(key, node);
    return;
  }
  const old = pair.value;
  if (Array.isArray(value)) {
    pair.value = rebuildSeq(doc, isSeq(old) ? old : undefined, value);
    return;
  }
  if (isScalar(old)) {
    old.value = value;
    return;
  }
  pair.value = doc.createNode(value);
}

/** 列を `values` の並びに作り直す。同じ値の既存の項目節点は (コメントごと) 使い回す。 */
function rebuildSeq(doc: Document, old: YAMLSeq | undefined, values: readonly unknown[]): YAMLSeq {
  const seq = old ?? new YAMLSeq();
  const pool = [...(old?.items ?? [])];
  seq.items = values.map((value) => {
    const index = pool.findIndex((item) => isScalar(item) && item.value === value);
    if (index === -1) return doc.createNode(value);
    const [reused] = pool.splice(index, 1);
    return reused;
  });
  if (!old) seq.flow = true;
  return seq;
}

function createCaseNode(doc: Document, value: CaseDefinition): Node {
  const out: Record<string, unknown> = { name: value.name, stdin: value.stdin, stdout: value.stdout };
  if (value.public) out.public = true;
  if (value.match !== 'trim') out.match = value.match;
  return doc.createNode(out);
}

function updateCaseNode(doc: Document, node: YAMLMap, previous: CaseDefinition, next: CaseDefinition): void {
  if (previous.name !== next.name) setKey(doc, node, 'name', next.name);
  for (const key of ['stdin', 'stdout'] as const) {
    if (previous[key] === next[key]) continue;
    // 書き方 (ブロックか引用符か) は yaml に選ばせ直す。古い型のまま値だけ変えると往復しないことがある
    const pair = findPair(node, key);
    const scalar = new Scalar(next[key]);
    if (pair && isScalar(pair.value)) scalar.comment = pair.value.comment;
    if (pair) pair.value = scalar;
    else node.set(key, scalar);
  }
  if (previous.public !== next.public) setKey(doc, node, 'public', next.public ? true : undefined);
  if (previous.match !== next.match) setKey(doc, node, 'match', next.match === 'trim' ? undefined : next.match);
}

/** 書き出して読み戻し、期待した値と一致することを確かめる。 */
function finish<T>(doc: Document, parse: (text: string) => ParseResult<T>, expected: T): SerializeResult {
  const text = doc.toString(TO_STRING_OPTIONS);
  const parsed = parse(text);
  if (!parsed.ok) return parsed;
  if (JSON.stringify(parsed.value) !== JSON.stringify(expected)) {
    return { ok: false, issues: [{ kind: 'unstable-value', key: '' }] };
  }
  return { ok: true, text };
}

/** ケースファイルを書き出す。ずれた stdin / stdout を二重引用符で書き直してから確かめる。 */
function finishCases(doc: Document, expected: readonly CaseDefinition[]): SerializeResult {
  stabilizeCaseStrings(doc, expected);
  const text = doc.toString(TO_STRING_OPTIONS);
  const parsed = parseCasesDefinition(text);
  if (!parsed.ok) return parsed;
  const issues: DefinitionIssue[] = [];
  expected.forEach((want, index) => {
    const got = parsed.value[index];
    for (const key of ['name', 'stdin', 'stdout', 'public', 'match'] as const) {
      if (got?.[key] !== want[key]) issues.push({ kind: 'unstable-value', key: `cases[${index}].${key}` });
    }
  });
  if (parsed.value.length !== expected.length) issues.push({ kind: 'unstable-value', key: 'cases' });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, text };
}

/**
 * yaml に書き方を選ばせた stdin / stdout のうち、読み戻すと値が変わるもの (空白だけの行を含む値を
 * `|+` で書く場合など) を二重引用符に切り替える。二重引用符はエスケープで任意の文字列を保てる。
 */
function stabilizeCaseStrings(doc: Document, expected: readonly CaseDefinition[]): void {
  const reparsed = parseDocument(doc.toString(TO_STRING_OPTIONS)).toJS() as { cases?: unknown };
  const actual = Array.isArray(reparsed?.cases) ? reparsed.cases : [];
  expected.forEach((want, index) => {
    const got: unknown = actual[index];
    for (const key of ['stdin', 'stdout'] as const) {
      if (isPlainObject(got) && got[key] === want[key]) continue;
      const node = doc.getIn(['cases', index, key], true);
      if (isScalar(node)) node.type = Scalar.QUOTE_DOUBLE;
    }
  });
}
