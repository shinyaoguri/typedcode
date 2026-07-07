/**
 * 封印平文の構造化版 — N問バンドルの符号化 / 復号 / per-problem ハッシュ (ADR-0012)。
 *
 * 役割: 1つの `.tcexam` に N 問をバンドルする平文ペイロード (`tcexam-exam/1`) の
 * **単一真実源**。authoring の封印前 (`encodeExamBundle`) と editor / grader の解錠後
 * (`decodeExamPlaintext`) が同じ符号化・正準化を共有する (`buildExamPackage` と同じ方針)。
 *
 * 不変条件:
 * - **後方互換**: 構造化されていない平文 (旧来の生 Markdown) は `legacy` として扱う。
 *   schema 判別に失敗したものはすべて legacy 問題文に畳む。
 * - **正準化**: per-problem ハッシュ (`computeBundleProblemHash`) は改行コードを正規化し
 *   キー順序を決定化した上で計算する。これを root v2 (ADR-0012 B-2) と proof.exam に焼くので、
 *   editor / grader 間で 1 bit でもズレると束縛検証が壊れる。
 *
 * 暗号コア (KDF/AES/署名/packageHash) には触れない。封印・署名は examPackage.ts のまま。
 */

import type { ExamBundle, ExamBundleProblem, DecodedExamPlaintext } from '../types/exam.js';
import type { TemplateFileDefinition } from '../types/template.js';
import { computeHash, deterministicStringify } from '../utils/hashUtils.js';

/** 封印平文の構造化 schema 識別子 (ADR-0012)。 */
export const EXAM_BUNDLE_SCHEMA = 'tcexam-exam/1' as const;

/** 改行コードを LF へ正規化 (CRLF / CR → LF)。ハッシュの安定化に使う。 */
function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** untrusted な starter (任意) を検証する。形が不正なら null、未指定なら undefined を返す。 */
function parseStarter(input: unknown): TemplateFileDefinition | null | undefined {
  if (input === undefined) return undefined;
  if (!isObj(input)) return null;
  if (!isNonEmptyStr(input.filename) || !isNonEmptyStr(input.language) || !isStr(input.content)) {
    return null;
  }
  return { filename: input.filename, language: input.language, content: input.content };
}

/**
 * untrusted な JSON を `ExamBundle` として構造検証する。形が不正なら null。
 * 真正性 (署名) は verifyExamPackageSignature、内容束縛は per-problem ハッシュが別途担う。
 */
export function parseExamBundle(input: unknown): ExamBundle | null {
  if (!isObj(input) || input.schema !== EXAM_BUNDLE_SCHEMA) return null;
  if (!Array.isArray(input.problems) || input.problems.length === 0) return null;

  const problems: ExamBundleProblem[] = [];
  const seenIds = new Set<string>();
  for (const raw of input.problems) {
    if (!isObj(raw)) return null;
    if (!isNonEmptyStr(raw.problemId) || !isStr(raw.statement)) return null;
    if (seenIds.has(raw.problemId)) return null; // problemId はバンドル内で一意
    seenIds.add(raw.problemId);
    const starter = parseStarter(raw.starter);
    if (starter === null) return null;
    const problem: ExamBundleProblem = { problemId: raw.problemId, statement: raw.statement };
    if (starter) problem.starter = starter;
    problems.push(problem);
  }
  return { schema: EXAM_BUNDLE_SCHEMA, problems };
}

/**
 * 復号後平文を解釈する (ADR-0012)。`tcexam-exam/1` バンドルとして妥当なら `bundle`、
 * それ以外 (非 JSON / schema 不一致 / 構造不正) は旧来の単一 Markdown 問題として `legacy` に畳む。
 */
export function decodeExamPlaintext(plaintext: string): DecodedExamPlaintext {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return { kind: 'legacy', statement: plaintext };
  }
  const bundle = parseExamBundle(parsed);
  if (!bundle) return { kind: 'legacy', statement: plaintext };
  return { kind: 'bundle', bundle };
}

/** 1問を正準形 (改行正規化済み・キー決定的) に整える。ハッシュと封印の入力に使う。 */
function canonicalProblem(problem: ExamBundleProblem): ExamBundleProblem {
  const canonical: ExamBundleProblem = {
    problemId: problem.problemId,
    statement: normalizeNewlines(problem.statement),
  };
  if (problem.starter) {
    canonical.starter = {
      filename: problem.starter.filename,
      language: problem.starter.language,
      content: normalizeNewlines(problem.starter.content),
    };
  }
  return canonical;
}

/**
 * 封印する平文文字列を組み立てる (ADR-0012)。`encode` 後の文字列を AES-256-GCM で暗号化する。
 * 各問を正準化した上で決定的シリアライズするので、同一バンドルは常に同一平文になる
 * (problemContentHash の安定性と再現性のため)。
 */
export function encodeExamBundle(bundle: ExamBundle): string {
  const canonical: ExamBundle = {
    schema: EXAM_BUNDLE_SCHEMA,
    problems: bundle.problems.map(canonicalProblem),
  };
  return deterministicStringify(canonical);
}

/**
 * per-problem の内容ハッシュ (ADR-0012)。`SHA-256(deterministicStringify(canonical(problem)))`。
 * **problemId を含む**ので問題ラベルの付け替えはハッシュ不一致で露見する。各タブの proof.exam に
 * 記録し、root v2 (B-2) に焼く。改行差で揺れないよう正準化してから計算する。
 */
export async function computeBundleProblemHash(problem: ExamBundleProblem): Promise<string> {
  return computeHash(deterministicStringify(canonicalProblem(problem)));
}
