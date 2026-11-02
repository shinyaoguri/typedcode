import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * exam round-trip 用の fixture (#229)。`npm run setup -w @typedcode/e2e` が
 * `scripts/setup-exam-fixture.mjs` で packages/e2e/fixtures/exam/ に生成する (gitignore 済み)。
 */
export interface ExamFixture {
  /** 監督コード (正準形)。 */
  code: string;
  /** 署名・封印した問題パッケージ (v2 バンドル 1 問、examId=e2e-exam)。 */
  packagePath: string;
  /** examId だけが違う別の問題パッケージ。packagePath の提出に束縛されない。 */
  otherPackagePath: string;
  /** 署名に使った出題者鍵の keyId (公開鍵は fixtures/exam/authority-keys.mjs)。 */
  keyId: string;
}

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE_DIR = resolve(HERE, '../../fixtures/exam');

/** fixture を読む。生成されていなければ null (呼び出し側が skip / fail を決める)。 */
export function loadExamFixture(): ExamFixture | null {
  const manifestPath = join(FIXTURE_DIR, 'fixture.json');
  if (!existsSync(manifestPath)) return null;
  const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    code: string;
    package: string;
    otherPackage: string;
    keyId: string;
  };
  return {
    code: m.code,
    packagePath: join(FIXTURE_DIR, m.package),
    otherPackagePath: join(FIXTURE_DIR, m.otherPackage),
    keyId: m.keyId,
  };
}
