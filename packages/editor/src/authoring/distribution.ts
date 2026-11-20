/**
 * 試験定義の変換結果から配布物 (`.tcexam` / `.tcclass`) の 1 ファイルを作る (#797 / ADR-0051)。DOM に触れない。
 *
 * 種類 (`kind`) で生成器を選ぶだけで、生成器 (`createExamBundlePackage` / `buildClassPackage`) は変えない。
 * - `exam`: 署名鍵と監督コードで封印・署名した `.tcexam`。鍵と監督コードは呼び出し側 (書き出しのパネルの入力欄) から
 *   受け取り、ここでもどこにも保存しない (ADR-0051 D7)
 * - `class`: 封印も署名もしない `.tcclass` (examId を classId に使う)。方針 (#645) は書き出しのパネルで選んだプリセット
 *   (「教室で実施」/「持ち帰り」) を `CLASS_POLICY_PRESETS` の値で書く。選んでいなければ書き出さない (黙って既定を当てない)
 */

import type { ExamBundleProblem } from '@typedcode/shared';
import { CLASS_POLICY_PRESETS, type ClassPolicyPreset } from '../core/mode.js';
import { buildClassPackage } from './classPackageAuthoring.js';
import { type CreatedExamPackage, createExamBundlePackage, importAuthoritySigner } from './examPackageAuthoring.js';
import type { ExamDefinition } from './workspace/definitions.js';

/**
 * オープンな締切 (ADR-0013: スケジュールは Moodle 管理)。manifest 仕様上 deadline は必須。
 * `packages/workers/scripts/make-exam-package.mjs` の `OPEN_DEADLINE` (既定 deadline) と同値に保つこと。
 */
export const OPEN_DEADLINE = '2999-12-31T23:59:59.999Z';

/** `.tcexam` を作るのに要る秘密 (保存しない)。 */
export interface ExamSecrets {
  readonly keyId: string;
  /** 出題者の私的 JWK (JSON 文字列) */
  readonly jwk: string;
  readonly embedPublicKey: boolean;
  readonly proctorToken: string;
}

export type Distribution =
  | { readonly kind: 'exam'; readonly filename: string; readonly content: string; readonly created: CreatedExamPackage }
  | { readonly kind: 'class'; readonly filename: string; readonly content: string };

/**
 * 配布物を作る。`exam` は `secrets` が、`class` は `classPolicy` が要る (無ければ throw)。`now` は releaseTime に使う。
 * @throws 鍵・方針が無い・鍵が読めない・生成器の検証に通らないとき (生成器の例外をそのまま投げる)
 */
export async function createDistribution(
  exam: ExamDefinition,
  problems: ExamBundleProblem[],
  options: { secrets?: ExamSecrets; classPolicy?: ClassPolicyPreset; now: Date }
): Promise<Distribution> {
  if (exam.kind === 'class') {
    const preset = options.classPolicy;
    if (!preset) throw new Error('A policy (classroom or take-home) is required for a class package');
    const policy = CLASS_POLICY_PRESETS[preset];
    const content = buildClassPackage({ classId: exam.examId, problems, languages: exam.languages, policy });
    return { kind: 'class', filename: `${exam.examId}.tcclass`, content: `${content}\n` };
  }
  const secrets = options.secrets;
  if (!secrets) throw new Error('A signing key and a proctor code are required for an exam package');
  const signer = await importAuthoritySigner(secrets.jwk, secrets.keyId, { embedPublicKey: secrets.embedPublicKey });
  const created = await createExamBundlePackage(
    {
      examId: exam.examId,
      problems,
      languages: exam.languages,
      releaseTime: options.now.toISOString(),
      deadline: OPEN_DEADLINE,
      proctorToken: secrets.proctorToken,
    },
    signer
  );
  return {
    kind: 'exam',
    filename: `${exam.examId}.tcexam`,
    content: `${JSON.stringify(created.manifest, null, 2)}\n`,
    created,
  };
}
