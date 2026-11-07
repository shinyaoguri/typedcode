/**
 * 出題時の入出力例の整え方 (#648 / ADR-0048)。
 *
 * `/author` の欄 (`AuthorPage.collectProblems`) と、配布物を組み立てる 2 か所
 * (`buildClassPackage` / `createExamBundlePackage`) が同じ規則で例を落とす。
 * 名前の空の例は書きかけとみなして書き出さない (shared の `parseExamBundle` は空の名前を
 * 不正な形として拒否するので、そのまま書き出すと配布物ごと読めなくなる)。
 */

import type { ProblemExample } from '@typedcode/shared';

/**
 * 名前 (前後の空白を除く) が空でない例だけを `{ name, stdin, stdout }` で作り直して返す。
 * 1 件も残らなければ undefined (= 問題に `examples` を持たせない。持たない問題の問題ハッシュを変えないため)。
 * stdin / stdout は空白も改行もそのまま残す (改行の正規化は shared の正準化が行う)。
 */
export function cleanProblemExamples(examples: readonly ProblemExample[] | undefined): ProblemExample[] | undefined {
  if (!examples) return undefined;
  const cleaned: ProblemExample[] = [];
  for (const example of examples) {
    const name = example.name.trim();
    if (!name) continue;
    cleaned.push({ name, stdin: example.stdin, stdout: example.stdout });
  }
  return cleaned.length > 0 ? cleaned : undefined;
}
