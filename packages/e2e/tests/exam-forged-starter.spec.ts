import { test, expect } from '@playwright/test';
import { EditorApp, readProofEvents, readProofJson } from './helpers/app.js';
import type { ProofCheckpoint } from './helpers/app.js';
import { EXAM_STRICT_FLAGS, loadExamFixture } from './helpers/examFixture.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * 試験の封印 starter と templateInjection の照合 (#718) の負の対照。
 *
 * 改造クライアントが完成コードを「雛形」(templateInjection) として注入した proof は、チェーン・署名 cp・
 * 受理ポリシーの 4 条件をすべて満たし、templateInjection は純タイピング判定に数えられない。
 * 照合が無いと Pure Typing のまま束縛 PASS で通ってしまう。ここでは同じ試験を正規に解錠し、
 * dev フック `__tcTestForgeTemplateInjection` (内容変更を記録せずにモデルを差し替える) で別の内容を注入 →
 * 本物の打鍵 → 実ローカル Workers の署名付き export → exam-roundtrip.spec.ts の正の対照と同じ条件の
 * verify-cli が exit 1 で、その理由が starter の不一致であることを確かめる。
 */

const FORGED_SOLUTION = 'int main(void) {\n  return 0;\n}\n';

const fixture = loadExamFixture();

test('exam: 封印 starter と違う内容を templateInjection で注入した proof は、署名 cp があっても verify-cli --exam-package が starter の不一致で exit 1 にする', async ({
  page,
}) => {
  if (!fixture) {
    if (process.env.CI)
      throw new Error('exam fixture is missing: `npm run setup -w @typedcode/e2e` did not generate it');
    test.skip(true, 'exam fixture 未生成 (npm run setup -w @typedcode/e2e で作る)');
    return;
  }

  const app = new EditorApp(page);
  await app.openModeFresh('exam', { screenShare: 'share', waitReady: false });
  await expect.poll(() => app.appState()).toBe('gate');
  // 署名 cp が載る経路 (ゲート中に得た token を署名専用に使う。#236 / ADR-0027) で解錠する。
  await expect(page.locator('#exam-gate-attestation')).toHaveAttribute('data-attestation-state', 'verified', {
    timeout: 30_000,
  });
  await app.unlockExam(fixture.packagePath, fixture.code);

  // 改造クライアントの再現: 封印 starter ではない完成コードを雛形として注入する (内容変更は記録しない)。
  await page.evaluate(async (content) => {
    const forge = (window as unknown as { __tcTestForgeTemplateInjection?: (c: string) => Promise<void> })
      .__tcTestForgeTemplateInjection;
    if (!forge) throw new Error('__tcTestForgeTemplateInjection is not available (dev build only)');
    await forge(content);
  }, FORGED_SOLUTION);
  // 注入の後に本物の打鍵を少し足す (打鍵の記録・署名 cp が普段どおり続くこと)。
  await app.typeCode('// done\n');
  await app.waitForSynced();

  const zipPath = await app.exportViaLogButton();

  const events = await readProofEvents(zipPath);
  const injections = events
    .map((e, index) => ({ index, type: e.type, content: (e.data as { content?: string } | undefined)?.content }))
    .filter((e) => e.type === 'templateInjection');
  // 前提: 正規の starter 注入 (#2) の後に、偽の注入が 1 つ載っている。
  expect(injections.map((e) => e.content)).toEqual([fixture.starter, FORGED_SOLUTION]);
  const forgedIndex = injections[1]!.index;

  // 前提: 署名 cp が 1 つ以上ある (時刻アンカーまで揃った proof でも starter 照合が落とすことを確かめる)。
  const proof = (await readProofJson(zipPath)) as { checkpoints?: ProofCheckpoint[] };
  const signed = (proof.checkpoints ?? []).filter((cp) => cp.signature);
  expect(signed.length, 'at least one checkpoint carries a signed envelope').toBeGreaterThan(0);

  const result = runVerifyCli(zipPath, [...EXAM_STRICT_FLAGS, '--exam-package', fixture.packagePath], {
    examAuthorityKeys: true,
  });
  expect(result.exitCode, result.stdout + result.stderr).toBe(1);
  // stdout のまま読む理由: 束縛の内訳と理由は人向け出力にしか無い (--result-json は exam 束縛の失敗を
  // 'other' までしか言わない。exam-roundtrip.spec.ts と同じ)。
  expect(result.stdout).toMatch(/Starter:\s+FAIL/);
  expect(result.stdout).toContain(`Template injection at event ${forgedIndex} does not match the sealed starter`);
  // starter 以外の束縛要素はすべて通る (落としたのが starter 照合であって、他の検査ではない)。
  for (const label of ['Root binding:', 'Signature:', 'Package hash:', 'Content hash:', 'Identifiers:']) {
    expect(result.stdout, `${label} PASS`).toMatch(new RegExp(`${label}\\s+PASS`));
  }
});
