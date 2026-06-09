/**
 * 授業モード (ADR-0014) の **問題配布オーサリング seam** — 平文問題から**未封印・非署名**の
 * `.tcclass` を生成する純粋コア。
 *
 * exam の `examPackageAuthoring.ts` と異なり**暗号・署名を一切持たない** (tier ① 自己申告)。
 * 問題は公開前提で、監督は教室の物理在室が担保する。問題バンドルは exam と同一の
 * `ExamBundle` 構造を内包し、検証ロジック (problemId 重複・空 statement・starter 不備) は
 * `createExamBundlePackage` と同じ規約を踏襲する。シリアライズは shared の `encodeClassPackage`。
 *
 * DOM 非依存・純関数。browser / Node (vitest) 双方で動く。
 */

import {
  encodeClassPackage,
  EXAM_BUNDLE_SCHEMA,
  CLASS_PACKAGE_SCHEMA,
  type ClassPackage,
  type ExamBundle,
  type ExamBundleProblem,
} from '@typedcode/shared';

/** `buildClassPackage` の入力。1つの `.tcclass` に N 問をまとめる (ADR-0014)。 */
export interface BuildClassPackageParams {
  /** 授業/課題の識別子 (自己申告ラベル)。/author では examId を流用する。 */
  classId: string;
  /** N 問。各問: problemId + statement + 任意の starter (単一ファイル)。 */
  problems: ExamBundleProblem[];
  /** 許可言語 (グローバル allow-list)。 */
  languages: string[];
}

/**
 * 平文 `.tcclass` 配布パッケージ文字列を作る (オーサリングの単一導線)。
 * 封印・署名はせず、`encodeClassPackage` で決定的にシリアライズするだけ。
 *
 * @throws classId 空 / 問題なし / problemId 重複・空 / statement 空 / starter 不備 / 言語なし。
 */
export function buildClassPackage(params: BuildClassPackageParams): string {
  const classId = params.classId.trim();
  if (!classId) {
    throw new Error('classId is required');
  }
  if (!params.problems || params.problems.length === 0) {
    throw new Error('At least one problem is required');
  }
  const languages = params.languages.map((l) => l.trim()).filter((l) => l.length > 0);
  if (languages.length === 0) {
    throw new Error('At least one allowed language is required');
  }

  const seen = new Set<string>();
  const problems: ExamBundleProblem[] = [];
  for (const p of params.problems) {
    const problemId = p.problemId.trim();
    if (!problemId) throw new Error('Each problem needs a problemId');
    if (seen.has(problemId)) throw new Error(`Duplicate problemId: ${problemId}`);
    seen.add(problemId);
    if (!p.statement || p.statement.trim().length === 0) {
      throw new Error(`Problem "${problemId}" has an empty statement`);
    }
    const cleaned: ExamBundleProblem = { problemId, statement: p.statement };
    if (p.starter && p.starter.content.length > 0) {
      const filename = p.starter.filename.trim();
      const language = p.starter.language.trim();
      if (!filename || !language) {
        throw new Error(`Problem "${problemId}" starter needs a filename and language`);
      }
      cleaned.starter = { filename, language, content: p.starter.content };
    }
    problems.push(cleaned);
  }

  const bundle: ExamBundle = { schema: EXAM_BUNDLE_SCHEMA, problems };
  const pkg: ClassPackage = {
    schema: CLASS_PACKAGE_SCHEMA,
    classId,
    allowed: { languages },
    bundle,
  };
  return encodeClassPackage(pkg);
}
