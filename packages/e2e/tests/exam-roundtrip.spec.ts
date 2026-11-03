import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { EditorApp, readProofEvents, readProofJson } from './helpers/app.js';
import type { ProofCheckpoint } from './helpers/app.js';
import { loadExamFixture } from './helpers/examFixture.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * 試験 (exam) モードの round-trip (#229): 封印問題パッケージを監督コードで解錠 → 打鍵 → export →
 * `verify-cli --exam-package` が束縛まで検証して pass する。
 *
 * オラクルは verify-cli の結論 (exit code と Exam binding セクションの PASS 行)。
 * - 誤コードはゲートに留まり (sticky)、正コードで解錠できる (Argon2id の復号は本番パラメータのまま)
 * - 負のオラクル: 別の問題パッケージ (examId だけ違う) を渡すと exit 1。出題者鍵を信頼しない
 *   本物の registry で検証しても exit 1 (E2E 用の鍵が差し込まれていることが pass の前提だと確かめる)
 * - `#0` の verified / signature の値は assert しない (#236 の方針決定で変わるため)。署名 envelope が
 *   1 つ以上載っていること (ADR-0027 の `acquireSigningTokenBestEffort` 経路) だけを見る
 *
 * fixture (出題者鍵・パッケージ) は `npm run setup -w @typedcode/e2e` が packages/e2e/fixtures/exam/ に
 * 生成する。shared の localKeys.ts (開発者の鍵置き場。gitignore 済み) は書き換えず、editor の dev サーバ (vite.editor.config.mjs)
 * と verify-cli (exam-keys/) が E2E の実行時だけ公開鍵を差し替える。verify-cli は既定どおり fast
 * (PoSW 全再計算は happy-path の 1 本だけ。AGENTS.md 不変条件 4)。
 */

const LOCAL_KEYS_TS = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../shared/src/examAuthorityKeys/localKeys.ts'
);

const fixture = loadExamFixture();

test('exam: 誤コードはゲートに留まり、正コードで解錠 → 打鍵 → export → verify-cli --exam-package が pass する', async ({
  page,
}) => {
  // CI で fixture が無いのは setup の配線の壊れ。skip で緑にせず落とす (「CI で skip されずに走る」が受け入れ条件)。
  if (!fixture) {
    if (process.env.CI)
      throw new Error('exam fixture is missing: `npm run setup -w @typedcode/e2e` did not generate it');
    test.skip(true, 'exam fixture 未生成 (npm run setup -w @typedcode/e2e で作る)');
    return;
  }

  // 開発者の鍵置き場に E2E の鍵を書いていない (書くと e2e の後も手元の verifier が使い捨ての出題者鍵を信頼し続ける。#229 / #338)。
  expect(readFileSync(LOCAL_KEYS_TS, 'utf8'), 'shared の localKeys.ts に E2E の鍵が混ざっている').not.toContain(
    fixture.keyId
  );

  const app = new EditorApp(page);
  await app.openModeFresh('exam', { screenShare: 'share', waitReady: false });

  await test.step('誤コードはゲートに留まる (sticky)', async () => {
    await expect.poll(() => app.appState()).toBe('gate');
    await app.submitExamGate(fixture.packagePath, 'ZZZZZZZZ');
    // 復号の失敗 (GCM 認証) でエラーが表示され、開始ボタンが戻る。解錠もしていない。
    await expect(page.locator('#exam-gate-error')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#exam-gate-start')).toBeEnabled();
    expect(await app.appState()).toBe('gate');
    await expect(page.locator('#exam-start-gate')).toBeVisible();
  });

  await test.step('正コードで解錠できる (署名検証 → 復号 → 束縛したチェーン)', async () => {
    await app.unlockExam(fixture.packagePath, fixture.code);
  });

  // 本物の打鍵で答案を書く。
  await app.typeCode('int main(void) {\n  return 0;\n}\n');
  expect(await app.editorValue()).toContain('int main(void)');
  await app.waitForSynced();

  const zipPath = await app.exportViaLogButton();

  // proof は exam として束縛され、開封イベントと署名 envelope が載っている。
  const proof = (await readProofJson(zipPath)) as { mode?: string; exam?: unknown; checkpoints?: ProofCheckpoint[] };
  expect(proof.mode).toBe('exam');
  expect(proof.exam, 'proof carries the exam block').toBeTruthy();
  const events = await readProofEvents(zipPath);
  expect(
    events.some((e) => e.type === 'examOpened'),
    'examOpened (#1) recorded on unlock'
  ).toBe(true);
  // ADR-0027: exam は root に署名 token を焼かず、acquireSigningTokenBestEffort で署名専用 token を取る。
  // その経路が死ぬと署名 envelope が 0 件になるが、未アンカーの proof も valid なので verify-cli では見えない。
  const signed = (proof.checkpoints ?? []).filter((cp) => cp.signature);
  expect(signed.length, 'at least one checkpoint carries a signed envelope').toBeGreaterThan(0);

  await test.step('正しい問題パッケージ: exit 0 と束縛 PASS', async () => {
    const ok = runVerifyCli(zipPath, ['--mode', 'fast', '--exam-package', fixture.packagePath], {
      examAuthorityKeys: true,
    });
    expect(ok.exitCode, ok.stdout + ok.stderr).toBe(0);
    // exit 0 だけでは束縛ブロックの欠落を見逃すので、束縛の各要素の PASS 行を個別に固定する。
    expect(ok.stdout).toContain('--- Exam binding (ADR-0006) ---');
    for (const label of ['Root binding:', 'Signature:', 'Package hash:', 'Content hash:']) {
      expect(ok.stdout, `${label} PASS`).toMatch(new RegExp(`${label}\\s+PASS`));
    }
  });

  await test.step('別の問題パッケージは束縛が合わず exit 1 (負のオラクル)', async () => {
    const other = runVerifyCli(zipPath, ['--mode', 'fast', '--exam-package', fixture.otherPackagePath], {
      examAuthorityKeys: true,
    });
    expect(other.exitCode, other.stdout + other.stderr).toBe(1);
    expect(other.stdout).toMatch(/Package hash:\s+FAIL/);
  });

  await test.step('本物の registry は E2E の出題者鍵を信頼せず exit 1 (差し替えが効いていることの裏取り)', async () => {
    const untrusted = runVerifyCli(zipPath, ['--mode', 'fast', '--exam-package', fixture.packagePath]);
    expect(untrusted.exitCode, untrusted.stdout + untrusted.stderr).toBe(1);
    expect(untrusted.stdout).toMatch(/Signature:\s+FAIL/);
  });
});
