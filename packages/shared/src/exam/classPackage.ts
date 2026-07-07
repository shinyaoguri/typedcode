/**
 * class モードの平文配布パッケージ (`*.tcclass`) の codec (ADR-0014, tier ①)。
 *
 * 役割: 授業モードの**未封印・非署名**な問題配布の単一真実源。authoring (`encodeClassPackage`)
 * と editor (`parseClassPackage`) が同じ符号化を共有する。`bundle` は exam と同一の `ExamBundle`
 * (`tcexam-exam/1`) なので、構造検証は examBundle.ts の `parseExamBundle` を再利用する。
 *
 * 不変条件:
 * - **暗号コードを一切持たない** (KDF/AES/署名は exam だけの責務)。class は問題が公開前提で、
 *   真正性は tier ①「自己申告」— proof の `mode:'class'` と starter 注入の problemId に委ねる。
 * - **後方互換**: schema/構造が不正なものはすべて `null` に畳む (呼び出し側が「未対応ファイル」扱い)。
 */

import type { ClassPackage, ExamBundle } from '../types/exam.js';
import { encodeExamBundle, parseExamBundle } from './examBundle.js';

/** class 配布パッケージの schema 識別子 (ADR-0014)。 */
export const CLASS_PACKAGE_SCHEMA = 'tcclass/1' as const;

const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** untrusted な `allowed.languages` を検証する。形が不正なら null。 */
function parseAllowed(input: unknown): { languages: string[] } | null {
  if (!isObj(input) || !Array.isArray(input.languages) || input.languages.length === 0) {
    return null;
  }
  const languages: string[] = [];
  for (const lang of input.languages) {
    if (!isNonEmptyStr(lang)) return null;
    languages.push(lang);
  }
  return { languages };
}

/**
 * untrusted な JSON を `ClassPackage` として構造検証する。形が不正なら null。
 * `bundle` の検証は examBundle.ts の `parseExamBundle` を再利用する (exam と共通の平文構造)。
 */
export function parseClassPackage(input: unknown): ClassPackage | null {
  if (!isObj(input) || input.schema !== CLASS_PACKAGE_SCHEMA) return null;
  if (!isNonEmptyStr(input.classId)) return null;
  const allowed = parseAllowed(input.allowed);
  if (!allowed) return null;
  const bundle = parseExamBundle(input.bundle);
  if (!bundle) return null;
  return { schema: CLASS_PACKAGE_SCHEMA, classId: input.classId, allowed, bundle };
}

/**
 * class 配布パッケージを決定的に符号化する (authoring 用)。`bundle` は `encodeExamBundle` で
 * 正準化 (改行正規化・キー決定化) してから埋め込むので、同一内容は常に同一文字列になる。
 */
export function encodeClassPackage(pkg: ClassPackage): string {
  const canonicalBundle = JSON.parse(encodeExamBundle(pkg.bundle)) as ExamBundle;
  const canonical: ClassPackage = {
    schema: CLASS_PACKAGE_SCHEMA,
    classId: pkg.classId,
    allowed: { languages: [...pkg.allowed.languages] },
    bundle: canonicalBundle,
  };
  return JSON.stringify(canonical, null, 2);
}
