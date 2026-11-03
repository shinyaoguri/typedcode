import { test, expect } from '@playwright/test';
import { EditorApp, tamperFirstContentChange, writeZipVariant } from './helpers/app.js';
import { runVerifyCliWithVerdicts } from './helpers/verifyCli.js';
import { VerifyWebApp, expectWebCliParity, proofNames, typeAndExport } from './helpers/verifyWeb.js';

/**
 * verify Web を通す往復 E2E (#346 PR 3 / 分割は #533): editor で打鍵 → export した ZIP を検証 Web に入れ、
 * 判定を **data-* の状態契約** (verify/AGENTS.md) で読む。翻訳テキスト・色クラスは見ない。
 *
 * このファイルは Web↔CLI パリティの系統。オラクルは verify-cli (不変条件 1): 同じ ZIP に対する CLI の判定と Web の判定が一致すること
 * (Web↔CLI パリティ) を軸にし、改ざんで両方が拒否する負のオラクルと対にする (不変条件 2)。
 * 検証はすべて fast (`?mode=fast` / `--mode fast`)。PoSW full は happy-path の 1 本だけ (不変条件 4)。
 * 同じ系統の兄弟: verify-web-parity / verify-web-submission / verify-web-ui (1 ファイルが CI で Slow Test の閾値 5 分を超えたため分割。共通の手順は helpers/verifyWeb.ts)。
 */

test('verify Web の判定が同じ ZIP に対する verify-cli の判定と一致する (無改ざん)', async ({ page }) => {
  const zipPath = await typeAndExport(new EditorApp(page));
  const names = await proofNames(zipPath);
  expect(names.length).toBeGreaterThan(0);

  const cli = runVerifyCliWithVerdicts(zipPath, ['--mode', 'fast']);
  expect(cli.passed, cli.stdout + cli.stderr).toBe(true);

  const web = new VerifyWebApp(page);
  await web.open('fast');
  await web.load([zipPath]);
  const verdicts = await web.readVerdicts(names);

  expectWebCliParity(verdicts, cli);
  // CLI と一致するだけでなく、値そのものも期待どおり (両方が同じ向きに壊れても緑にしない)。
  for (const v of verdicts) {
    expect(v.status, JSON.stringify(v)).not.toBe('error');
    expect(v.integrity, 'fast は PoSW を再計算しないので partial (#214)').toBe('partial');
    expect(v.pureTyping, '打鍵だけのセッション').toBe('true');
    expect(v.level).not.toBe('failed');
  }
});

test('改ざんした ZIP を verify Web が error として出し、verify-cli と同じく拒否する', async ({ page }) => {
  const zipPath = await typeAndExport(new EditorApp(page));
  const tamperedZip = await writeZipVariant(zipPath, {
    mutateProof: tamperFirstContentChange,
    outName: 'tampered.zip',
  });
  const names = await proofNames(tamperedZip);

  const cli = runVerifyCliWithVerdicts(tamperedZip, ['--mode', 'fast']);
  expect(cli.exitCode, 'tampered proof must be rejected\n' + cli.stdout).toBe(1);

  const web = new VerifyWebApp(page);
  await web.open('fast');
  await web.load([tamperedZip]);
  const verdicts = await web.readVerdicts(names);

  expectWebCliParity(verdicts, cli);
  for (const v of verdicts) {
    expect(v.status, JSON.stringify(v)).toBe('error');
    expect(v.tabStatus).toBe('error');
    // 判定を出すなら failed、出さないなら属性なし (null)。proven / partial は改ざんの見逃し。
    expect([null, 'failed'], JSON.stringify(v)).toContain(v.integrity);
    expect([null, 'failed'], JSON.stringify(v)).toContain(v.level);
  }
});

test('未知の新 major の proof は reject されず、verify Web と verify-cli の両方が warning を出す (#223)', async ({
  page,
}) => {
  const zipPath = await typeAndExport(new EditorApp(page));
  // version は typingProofHash の入力ではないので、書き換えても他の検査は無傷 (差は version だけから生じる)。
  const newerZip = await writeZipVariant(zipPath, {
    mutateProof: (proof) => {
      proof.version = '2.0.0';
    },
    outName: 'newer-major.zip',
  });
  const names = await proofNames(newerZip);

  const cli = runVerifyCliWithVerdicts(newerZip, ['--mode', 'fast']);
  expect(cli.exitCode, 'a newer major is a warning, not a rejection\n' + cli.stdout).toBe(0);
  expect(cli.stdout).toContain('is newer than this verifier supports');

  const web = new VerifyWebApp(page);
  await web.open('fast');
  await web.load([newerZip]);
  const verdicts = await web.readVerdicts(names);

  expectWebCliParity(verdicts, cli);
  for (const v of verdicts) {
    expect(v.status, JSON.stringify(v)).not.toBe('error');
    await web.selectFile(v.filename);
    expect(await web.trustIssues(), v.filename).toContainEqual({ component: 'version', severity: 'warning' });
  }
});

test('下限未満の version の proof を verify Web が error として出し、verify-cli と同じく拒否する (#223)', async ({
  page,
}) => {
  const zipPath = await typeAndExport(new EditorApp(page));
  const oldZip = await writeZipVariant(zipPath, {
    mutateProof: (proof) => {
      proof.version = '0.1.0';
    },
    outName: 'too-old.zip',
  });
  const names = await proofNames(oldZip);

  const cli = runVerifyCliWithVerdicts(oldZip, ['--mode', 'fast']);
  expect(cli.exitCode, cli.stdout).toBe(1);
  expect(cli.stdout).toContain('older than the minimum supported version');

  const web = new VerifyWebApp(page);
  await web.open('fast');
  await web.load([oldZip]);
  const verdicts = await web.readVerdicts(names);

  expectWebCliParity(verdicts, cli);
  for (const v of verdicts) {
    expect(v.status, JSON.stringify(v)).toBe('error');
    // チェーンは無傷なので改ざん告発 (integrity failed) にはしない。理由は version の issue として出る。
    expect(v.integrity).not.toBe('failed');
    await web.selectFile(v.filename);
    expect(await web.trustIssues(), v.filename).toContainEqual({ component: 'version', severity: 'error' });
  }
});
