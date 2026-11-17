/**
 * export ZIP の README の問題文の節 (#778)。
 *
 * 授業・課題で同梱した `<base>_problem.md` を一覧に載せ、証明の対象外 (ハッシュチェーンにも証明ファイルにも
 * 入らず、検証では読まない) と書く。問題文が無い ZIP (casual / exam) には節を出さない。
 */

import { describe, it, expect } from 'vitest';
import { generateReadmeJa } from '../readme-template-ja.js';
import { generateReadmeEn } from '../readme-template-en.js';

const base = {
  timestamp: '2026-01-01T00:00:00.000Z',
  totalFiles: 2,
  totalScreenshots: 0,
  sourceFiles: ['p1.c', 'p2.c'],
  proofFiles: ['p1_proof.json', 'p2_proof.json'],
};

const withProblems = { ...base, problemFiles: ['p1_problem.md', 'p2_problem.md'] };

/** 見出し `### <heading>` から次の `###` / `---` までの節を取り出す (無ければ null)。 */
function section(readme: string, heading: string): string | null {
  const start = readme.indexOf(`### ${heading}`);
  if (start < 0) return null;
  const rest = readme.slice(start + 4);
  const end = rest.search(/\n(?:###|---)/);
  return end < 0 ? rest : rest.slice(0, end);
}

describe('README problem statement section', () => {
  it('ja: lists every bundled problem statement under a section that says it is not covered by the proof', () => {
    const body = section(generateReadmeJa(withProblems), '問題文（証明の対象外）');
    expect(body).toContain('- `p1_problem.md`');
    expect(body).toContain('- `p2_problem.md`');
    expect(body).toContain('ハッシュチェーンにも証明ファイルにも含まれず');
  });

  it('en: lists every bundled problem statement under a section that says it is not covered by the proof', () => {
    const body = section(generateReadmeEn(withProblems), 'Problem Statements (not covered by the proof)');
    expect(body).toContain('- `p1_problem.md`');
    expect(body).toContain('- `p2_problem.md`');
    expect(body).toContain('not part of the hash chain or the proof files');
  });

  it('omits the section in both languages when no problem statement is bundled', () => {
    for (const readme of [generateReadmeJa({ ...base, problemFiles: [] }), generateReadmeEn(base)]) {
      expect(readme).not.toContain('_problem');
      expect(readme).not.toMatch(/問題文|Problem Statements/);
    }
  });
});
